import type { ObserverData } from "./observer-data";
import { traceItems } from "./artifact-href";
import { buildPlayerModel, rowElapsedMs, type PlayerFrame } from "./player-model";

/** An optional review projection. It does not change the recorded Observer contract. */
export interface StudyReport {
  id: string;
  runId: string;
  state?: "complete" | "partial" | "failed" | "cancelled" | "stale" | "invalid";
  messages?: string[];
  admissionExceeded?: boolean;
  summary: string;
  scope: string;
  findings: StudyFinding[];
  outcomes: { streamId: string; label: string }[];
  participants?: ParticipantAnalysis[];
  concernReviews?: {
    claim: string; basis: ObservationBasis; limitation: string;
    disposition: "finding" | "context" | "unsupported"; findingId: string | null; reason: string;
    moments: { streamId: string; eventId: string }[];
  }[];
  methodology: string[];
}

export type ObservationBasis = "visual" | "action" | "participant_statement" | "inference";
export const basisLabel: Record<ObservationBasis, string> = { visual: "Visual observation", action: "Recorded action", participant_statement: "Participant statement", inference: "Inference" };
export interface ParticipantAnalysis {
  streamId: string; summary: string; intent: string; outcome: string; outcomeReason: string;
  limitations: string[]; stale: boolean; moments: { eventId: string; label: string; elapsedMs: number | null; at: string | null; text: string }[];
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
  accounts?: { text: string; label: string; streamId: string; eventId: string }[];
  observations?: { claim: string; basis: ObservationBasis; limitation: string }[];
  leadEventId?: string;
  corrections?: { status: "confirmed" | "dismissed" | "amended"; reason: string; replacementClaim: string | null; createdAt: string }[];
  moments: { streamId: string; eventId: string; label: string; note: string; bases?: ObservationBasis[] }[];
}

export function resolveReportMoment(data: ObserverData, streamId: string, eventId: string) {
  const stream = data.streams.find((item) => item.id === streamId);
  if (!stream) return null;
  const model = buildPlayerModel(stream);
  const row = model?.rows.find((item) => item.id === eventId);
  const candidate = row ? model?.frames[row.frameIndex] : undefined;
  // Events before the first retained capture do not acquire a future screenshot.
  const frame: PlayerFrame | null = candidate && !(row?.atMs !== undefined && candidate.atMs !== undefined && row.atMs < candidate.atMs) ? candidate : null;
  const item = traceItems(stream).find((item) => item.id === eventId);
  const event = stream.timeline.find((item) => item.id === eventId);
  if (!row && !item && !event) return null;
  return { stream, frame, frameIndex: frame?.index ?? null, eventId: row?.isFrame && frame ? undefined : eventId,
    elapsedMs: frame && model?.paced === "recorded" && row ? rowElapsedMs(model, row) : null,
    at: item?.at ?? event?.at ?? null, text: item?.text ?? item?.title ?? event?.message ?? row?.text ?? row?.title ?? "",
    kind: item?.kind ?? event?.type ?? row?.kind ?? "event" };
}

export function reportProblem(data: ObserverData, report: StudyReport): string | null {
  if (report.runId !== data.run.runId) return "This report belongs to a different study.";
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) return "Finding identifiers are duplicated.";
  for (const finding of report.findings) {
    if (!finding.id || !finding.moments.length) return "A finding has no supporting evidence.";
    if (finding.leadEventId && !finding.moments.some((moment) => moment.eventId === finding.leadEventId)) return "The selected evidence is unavailable.";
    if (report.state !== "stale" && finding.moments.some((moment) => !resolveReportMoment(data, moment.streamId, moment.eventId))) return "Some report evidence is unavailable in this study.";
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
