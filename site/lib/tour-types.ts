/** Shape of lib/tour/<slug>.json, written by landing/site-redesign-0916/extract-tour.py from a run bundle. */
export interface TourAction { id: string; title: string; coord: { x: number; y: number } | null; at: string | null; text?: string | null }
export interface TourReasoning { id: string; text: string; at: string | null; message?: boolean }
export interface TourFrame {
  id: string; title: string; at: string | null; file: string;
  actionsBefore: TourAction[]; reasoningBefore: TourReasoning[];
}
export interface TourLane {
  lane: string | null; laneId: string | null; provider: string | null; persona: string | null;
  status: string | null; completionReason: string | null; reason: string | null; durationMs: number | null;
  counts: Record<string, number> | null;
  frames: TourFrame[]; trailingActions: TourAction[]; trailingReasoning: TourReasoning[];
}
export interface TourFinding { title: string; summary: string; impact: string; evidence: Array<{ id: string | null; label: string | null }> }
export interface TourVerify { status: string | null; reasons: Array<{ code: string; message: string }> | null; checks: Array<{ name: string; ok: boolean; detail: string }> }
export interface TourData { runId: string; lanes: TourLane[]; findings?: TourFinding[]; analysisSummary?: string; verify?: TourVerify }

export function elapsed(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return "--:--";
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
