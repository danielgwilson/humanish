/** Navigation provenance is view state, separate from recorded evidence and preferences. */
export type RecordingSource =
  | { runId: string; kind: "participants" }
  | { runId: string; kind: "finding"; findingId: string }
  | { runId: string; kind: "concerns" }
  | { runId: string; kind: "comparison"; hash: string };

export function recordingSource(state: unknown, runId: string, findingIds: string[] = [], hasConcerns = false): RecordingSource {
  const fallback: RecordingSource = { runId, kind: "participants" };
  if (!state || typeof state !== "object") return fallback;
  const value: unknown = (state as Record<string, unknown>).humanishRecordingSource;
  if (!value || typeof value !== "object") return fallback;
  const source = value as Record<string, unknown>;
  if (source.runId !== runId) return fallback;
  if (source.kind === "concerns" && hasConcerns) return { runId, kind: "concerns" };
  if (source.kind === "finding" && typeof source.findingId === "string" && findingIds.includes(source.findingId)) {
    return { runId, kind: "finding", findingId: source.findingId };
  }
  if (source.kind === "comparison" && typeof source.hash === "string" && source.hash.startsWith("#/compare?") && source.hash.length < 2048) {
    return { runId, kind: "comparison", hash: source.hash };
  }
  return fallback;
}

export function recordingState(source: RecordingSource) {
  return { humanishRecordingSource: source };
}
