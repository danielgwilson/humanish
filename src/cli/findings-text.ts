// The text of a run's `humanish.analysis-findings.v1` view (findings.ts): the full block `review`
// and `analyze show` print, and the summary at the end of a live `run`. It reads only the view.

import path from "node:path";
import { findingLead } from "../analysis/finding-lead.js";
import { plural } from "../run/text.js";
import type { AnalysisFindings } from "./findings.js";

type FindingView = AnalysisFindings["findings"][number];
type FindingEvidence = FindingView["evidence"][number];
type DesignFindingView = NonNullable<AnalysisFindings["designFindings"]>[number];
type CitedEvidence = DesignFindingView["evidence"][number];

const IMPACT_TEXT: Record<FindingView["impact"], string> = {
  blocked_task: "blocked task",
  friction: "friction",
  recovery: "recovery",
  uncertain: "uncertain",
};

const RECOVERY_TEXT: Record<FindingView["recovery"], string> = {
  recovered: "recovered",
  not_observed: "no recovery observed",
  unknown: "recovery unknown",
};

/** `+1:05` from milliseconds since the first retained capture. */
function elapsedText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `+${hours}:${String(minutes % 60).padStart(2, "0")}:${ss}`
    : `+${minutes}:${ss}`;
}

/** One participant's cited moments: each frame once, at its earliest cited time. */
function momentsText(evidence: FindingEvidence[]): string {
  const frames = new Map<number, number | null>();
  let unframed = 0;
  for (const entry of evidence) {
    if (entry.frame === null) {
      unframed++;
      continue;
    }
    const earlier = frames.get(entry.frame);
    if (
      earlier === undefined ||
      (entry.elapsedMs !== null && (earlier ?? Infinity) > entry.elapsedMs)
    )
      frames.set(entry.frame, entry.elapsedMs);
  }
  const parts = [...frames]
    .sort(([a], [b]) => a - b)
    .map(([frame, ms]) => `frame ${frame}${ms === null ? "" : ` at ${elapsedText(ms)}`}`);
  if (unframed > 0) parts.push(`${plural(unframed, "item")} with no frame`);
  return parts.join(", ");
}

/** The capture files, relative to the run directory, in frame order. */
function captureFiles(evidence: CitedEvidence[], runRoot: string): string[] {
  return [
    ...new Set(
      evidence
        .filter((entry) => entry.capture !== null)
        .sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0))
        .map((entry) => (runRoot ? path.relative(runRoot, entry.capture!) : entry.capture!)),
    ),
  ];
}

function findingLines(finding: FindingView, runRoot: string): string[] {
  const cited = [...new Set(finding.evidence.map((entry) => entry.streamId))];
  const labels = new Map(finding.affected.map((p) => [p.streamId, p.label]));
  const affectedIds = finding.affected.map((p) => p.streamId);
  const streams = [...affectedIds, ...cited.filter((id) => !labels.has(id))];
  const captures = captureFiles(finding.evidence, runRoot);
  const correction = finding.correction;
  const lead = findingLead(finding, correction);
  return [
    ...(lead === null
      ? [`${finding.id} ${finding.title}`]
      : [
          `${finding.id} ${lead.headline}`,
          ...(lead.account === null ? [] : [`   ${lead.account}`]),
          `   evidence: ${finding.title}`,
        ]),
    `   impact: ${IMPACT_TEXT[finding.impact]} · confidence: ${finding.confidence} · recovery: ${RECOVERY_TEXT[finding.recovery]}`,
    `   ${finding.summary}`,
    `   affected: ${finding.affected.length} of ${plural(finding.exposedCount, "exposed participant")}`,
    ...streams.map((streamId) => {
      const moments = momentsText(finding.evidence.filter((entry) => entry.streamId === streamId));
      const label = `${labels.get(streamId) ?? streamId}${labels.has(streamId) ? "" : " (cited, not affected)"}`;
      return `   - ${label}${moments ? `: ${moments}` : ""}`;
    }),
    ...(captures.length === 0 ? [] : [`   captures: ${captures.join(", ")}`]),
    `   next step: ${finding.nextStep}`,
    ...(correction === null
      ? []
      : [
          `   human review: ${correction.status}, ${correction.reason}${correction.replacementClaim ? ` Amended claim: ${correction.replacementClaim}` : ""}`,
        ]),
  ];
}

function designFindingLines(finding: DesignFindingView, runRoot: string): string[] {
  const captures = captureFiles(finding.evidence, runRoot);
  return [
    `${finding.id} ${finding.severity}: ${finding.headline}`,
    `   screen: ${finding.screen}`,
    `   notice: ${finding.notice}`,
    `   why it matters: ${finding.whyItMatters}`,
    `   suggestion: ${finding.suggestion}`,
    `   seen by: ${finding.seenBy.map((p) => p.label).join(", ")} · confidence: ${finding.confidence}`,
    ...(captures.length === 0 ? [] : [`   captures: ${captures.join(", ")}`]),
  ];
}

/** Nothing for an analysis written before design findings. */
function designSection(view: AnalysisFindings): string[] {
  const design = view.designFindings;
  if (design === null) return [];
  if (design.length === 0) return ["", "design findings: none in the reviewed captures"];
  return [
    "",
    `design findings: ${design.length}, most severe first`,
    ...design.flatMap((finding, index) => [
      ...(index === 0 ? [] : [""]),
      ...designFindingLines(finding, view.runPath ?? ""),
    ]),
  ];
}

/** The full findings block: the analysis, every finding with its evidence, and its limitations. */
export function formatFindings(view: AnalysisFindings): string[] {
  if (view.state !== "ready" && view.state !== "stale")
    return [`findings: none. ${view.message}`, ...(view.next ? [`next: ${view.next}`] : [])];
  const model = [view.provider, view.model].filter(Boolean).join(" ");
  const cost =
    view.estimatedCostUsd === null ? "" : `, estimated $${view.estimatedCostUsd.toFixed(2)}`;
  return [
    `findings: ${view.findings.length} from analysis ${view.analysisId} (${view.status}, ${model}${cost})`,
    ...(view.state === "stale" ? [`warning: ${view.message}`, `next: ${view.next}`] : []),
    ...(view.summary ? [view.summary] : []),
    ...view.findings.flatMap((finding) => ["", ...findingLines(finding, view.runPath ?? "")]),
    ...designSection(view),
    ...(view.limitations.length === 0
      ? []
      : ["", "limitations:", ...view.limitations.map((limitation) => `- ${limitation}`)]),
    ...view.warnings.map((warning) => `warning: ${warning}`),
    "",
    `analysis: ${view.path}`,
  ];
}

/** At most `limit` findings, one line each, and the command that prints all of them. */
export function formatFindingsSummary(
  view: AnalysisFindings,
  fullCommand: string,
  limit = 3,
): string[] {
  if (view.state !== "ready" && view.state !== "stale")
    return [`findings: ${view.message}`, ...(view.next ? [`next: ${view.next}`] : [])];
  const shown = view.findings.slice(0, limit);
  const design = view.designFindings;
  return [
    `findings: ${view.findings.length === 0 ? "none" : view.findings.length}${view.state === "stale" ? " (stale)" : ""}`,
    ...shown.map((finding) => {
      const qualities = `${IMPACT_TEXT[finding.impact]}, ${finding.confidence} confidence, ${RECOVERY_TEXT[finding.recovery]}`;
      const lead = findingLead(finding, finding.correction);
      if (lead === null) return `- ${finding.id} ${qualities}: ${finding.title}`;
      return `- ${finding.id} ${lead.headline} (${lead.corrected ? "corrected in human review" : qualities})`;
    }),
    ...(view.findings.length > limit
      ? [`- and ${plural(view.findings.length - limit, "more finding")}`]
      : []),
    ...(design === null
      ? []
      : [
          `design findings: ${design.length === 0 ? "none" : design.length}`,
          ...design
            .slice(0, limit)
            .map((finding) => `- ${finding.id} ${finding.severity}: ${finding.headline}`),
          ...(design.length > limit
            ? [`- and ${plural(design.length - limit, "more design finding")}`]
            : []),
        ]),
    `all findings: ${fullCommand}`,
  ];
}
