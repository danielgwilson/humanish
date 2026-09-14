import type { ObserverData } from "./observer-data";
import { buildPlayerModel, rowElapsedMs } from "./player-model";

/** An optional review projection. It does not change the recorded Observer contract. */
export interface StudyReport {
  id: string;
  runId: string;
  summary: string;
  scope: string;
  findings: StudyFinding[];
  outcomes: { streamId: string; label: string }[];
  methodology: string[];
}

export interface StudyFinding {
  id: string;
  title: string;
  shortTitle?: string;
  impact: string;
  summary: string;
  scope: string;
  limitation: string;
  nextStep: string;
  priorityReason: string;
  account: string;
  accountSource: string;
  leadEventId?: string;
  moments: { streamId: string; eventId: string; label: string; note: string }[];
}

export function resolveReportMoment(data: ObserverData, streamId: string, eventId: string) {
  const stream = data.streams.find((item) => item.id === streamId);
  const model = stream ? buildPlayerModel(stream) : null;
  const row = model?.rows.find((item) => item.id === eventId);
  const frame = row ? model?.frames[row.frameIndex] : undefined;
  if (!stream || !model || !row || !frame) return null;
  return { stream, frame, frameIndex: frame.index, eventId: row.isFrame ? undefined : row.id, elapsedMs: rowElapsedMs(model, row) };
}

export function reportProblem(data: ObserverData, report: StudyReport): string | null {
  if (report.runId !== data.run.runId) return "This report belongs to a different study.";
  if (!report.findings.length) return "This report has no findings to review.";
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) return "Finding identifiers are duplicated.";
  for (const finding of report.findings) {
    if (!finding.id || !finding.moments.length) return "A finding has no supporting evidence.";
    if (finding.leadEventId && !finding.moments.some((moment) => moment.eventId === finding.leadEventId)) return "The selected evidence is unavailable.";
    if (finding.moments.some((moment) => !resolveReportMoment(data, moment.streamId, moment.eventId))) return "Some report evidence is unavailable in this study.";
  }
  if (new Set(report.outcomes.map((outcome) => outcome.streamId)).size !== report.outcomes.length) return "Reviewed participants are duplicated.";
  if (report.outcomes.some((outcome) => !data.streams.some((stream) => stream.id === outcome.streamId))) return "A reviewed participant is unavailable.";
  return null;
}

export function reportHash(id?: string): string {
  return id ? `#/report/${encodeURIComponent(id)}` : "#/report";
}

export function reportFindingId(hash: string): string | null {
  const match = /^#\/report(?:\/([^/]+))?$/.exec(hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1] ?? ""); } catch { return null; }
}
