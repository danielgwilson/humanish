import { OBSERVER_DATA_SCHEMA } from "./data";
import type { ObserverData, ObserverStream } from "./observer-data";

// Live semantics carried over from the legacy client (src/observer-assets.ts) so the
// rebuilt Observer behaves identically on the watch/serve surfaces: 5s no-store polls
// of the sibling observer-data.json, a 30s history refresh, everything silent on
// transient failure, and nothing network-touching on a file:// open.

export const OBSERVER_POLL_MS = 5000;
export const HISTORY_POLL_MS = 30_000;

export function isServedOrigin(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** The lane's live view URL when the attached watch injected one and the sandbox still
 *  exists. liveEnded (#357) wins: a dead sandbox's URL renders a provider error page
 *  that is pixel-identical to a crash, so ended lanes fall back to recorded frames. */
export function liveEmbedUrl(stream: ObserverStream): string | null {
  if (stream.liveEnded === true) return null;
  if (stream.embed?.kind === "iframe" && typeof stream.embed.url === "string" && stream.embed.url !== "") {
    return stream.embed.url;
  }
  return null;
}

/** Where playback should land after a data refresh grows the frame timeline: a viewer
 *  sitting on the newest frame follows the live edge; a viewer who scrubbed back is
 *  doing instant replay and stays put. */
export function followTarget(prevFrame: number, prevCount: number, nextCount: number): number {
  if (nextCount <= prevCount) return Math.min(prevFrame, Math.max(0, nextCount - 1));
  return prevFrame >= prevCount - 1 ? nextCount - 1 : prevFrame;
}

export async function fetchObserverData(fetchImpl: typeof fetch): Promise<ObserverData | null> {
  try {
    const response = await fetchImpl("observer-data.json", { cache: "no-store" });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { schema?: unknown }).schema === OBSERVER_DATA_SCHEMA
    ) {
      return parsed as ObserverData;
    }
  } catch {
    // Transient poll failure (server mid-write, network blip): keep the last snapshot.
  }
  return null;
}

export interface HistoryRun {
  runId: string;
  href: string;
  status: string;
  mode: string | null;
  streamCount: number;
}

export interface HistoryIndex {
  latestRunId: string | null;
  runs: HistoryRun[];
}

export async function fetchHistoryIndex(fetchImpl: typeof fetch): Promise<HistoryIndex | null> {
  try {
    const response = await fetchImpl("/_humanish/history.json", { cache: "no-store" });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { runs?: unknown }).runs)) {
      return null;
    }
    const raw = parsed as { latestRunId?: unknown; runs: unknown[] };
    const runs: HistoryRun[] = [];
    for (const entry of raw.runs) {
      if (entry === null || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.runId !== "string" || typeof candidate.href !== "string") continue;
      runs.push({
        runId: candidate.runId,
        href: candidate.href,
        status: typeof candidate.status === "string" ? candidate.status : "unknown",
        mode: typeof candidate.mode === "string" ? candidate.mode : null,
        streamCount: typeof candidate.streamCount === "number" ? candidate.streamCount : 0
      });
    }
    return { latestRunId: typeof raw.latestRunId === "string" ? raw.latestRunId : null, runs };
  } catch {
    return null;
  }
}
