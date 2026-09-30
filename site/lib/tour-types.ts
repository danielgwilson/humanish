/** Shape of lib/tour/<slug>.json, extracted from a run bundle by a script that is not in this repository. */
interface TourAction {
  id: string;
  title: string;
  coord: { x: number; y: number } | null;
  at: string | null;
  text?: string | null;
}
interface TourReasoning {
  id: string;
  text: string;
  at: string | null;
  message?: boolean;
}
interface TourFrame {
  id: string;
  title: string;
  at: string | null;
  file: string;
  actionsBefore: TourAction[];
  reasoningBefore: TourReasoning[];
}
export interface TourLane {
  lane: string | null;
  laneId: string | null;
  provider: string | null;
  persona: string | null;
  status: string | null;
  completionReason: string | null;
  reason: string | null;
  durationMs: number | null;
  counts: Record<string, number> | null;
  frames: TourFrame[];
  trailingActions: TourAction[];
  trailingReasoning: TourReasoning[];
}
interface TourFinding {
  title: string;
  summary: string;
  impact: string;
  evidence: Array<{ id: string | null; label: string | null }>;
}
interface TourVerify {
  status: string | null;
  reasons: Array<{ code: string; message: string }> | null;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}
export interface TourData {
  runId: string;
  lanes: TourLane[];
  findings?: TourFinding[];
  analysisSummary?: string;
  verify?: TourVerify;
}

export function elapsed(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return "--:--";
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
