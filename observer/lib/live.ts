import { historyRunHref, traceItems } from "./artifact-href";
import type { ObserverData, ObserverStream } from "./observer-data";
import { isObserverData } from "./validate";

export const OBSERVER_POLL_MS = 5000;
export const HISTORY_POLL_MS = 30_000;
export function isServedOrigin(protocol: string): boolean { return protocol === "http:" || protocol === "https:"; }

/** Availability is not connectivity. A provider iframe can load an error page;
 * this URL only authorizes offering a preview, never a 'connected' assertion. */
export function liveEmbedUrl(stream: ObserverStream): string | null {
  if (stream.liveEnded === true || stream.embed?.kind !== "iframe") return null;
  const value = stream.embed.url;
  if (!value || value.length > 16_384 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function followTarget(prevFrame: number, prevCount: number, nextCount: number): number {
  if (nextCount <= prevCount) return Math.min(prevFrame, Math.max(0, nextCount - 1));
  return prevFrame >= prevCount - 1 ? nextCount - 1 : prevFrame;
}

export async function fetchObserverData(fetchImpl: typeof fetch, url = "observer-data.json", signal?: AbortSignal): Promise<ObserverData | null> {
  try {
    const response = await fetchImpl(url, { cache: "no-store", signal: signal ?? null });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return isObserverData(parsed) ? parsed : null;
  } catch { return null; }
}

export interface HistoryRun { runId: string; href: string; status: string; mode: string | null; streamCount: number; createdAt?: string; runtimeState?: "running" | "finished" | "interrupted" | "unknown"; }
export interface HistoryIndex { latestRunId: string | null; runs: HistoryRun[]; }
export async function fetchHistoryIndex(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<HistoryIndex | null> {
  try {
    const response = await fetchImpl("/_humanish/history.json", { cache: "no-store", signal: signal ?? null });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { runs?: unknown }).runs)) return null;
    const raw = parsed as { latestRunId?: unknown; runs: unknown[] };
    const runs: HistoryRun[] = [];
    for (const entry of raw.runs.slice(0, 10_000)) {
      if (entry === null || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.runId !== "string") continue;
      const href = historyRunHref(candidate.runId);
      if (href === null) continue;
      runs.push({ runId: candidate.runId, href,
        status: typeof candidate.status === "string" ? candidate.status : "unknown",
        mode: typeof candidate.mode === "string" ? candidate.mode : null,
        streamCount: typeof candidate.streamCount === "number" && Number.isFinite(candidate.streamCount) ? candidate.streamCount : 0,
        ...(typeof candidate.runtimeState === "string" && ["running", "finished", "interrupted", "unknown"].includes(candidate.runtimeState) ? { runtimeState: candidate.runtimeState as NonNullable<HistoryRun["runtimeState"]> } : {}),
        ...(typeof candidate.createdAt === "string" ? { createdAt: candidate.createdAt } : {}) });
    }
    return { latestRunId: typeof raw.latestRunId === "string" ? raw.latestRunId : null, runs };
  } catch { return null; }
}

export function isActiveStream(stream: ObserverStream): boolean { return stream.status === "running" || stream.status === "preparing"; }
export function sourceUpdatedAt(data: ObserverData): number | null {
  const values = data.streams.flatMap((stream) => [stream.updatedAt, stream.liveActor?.updatedAt,
    ...traceItems(stream).slice(-1).map((item) => item.at)]).filter((v): v is string => typeof v === "string");
  const stamps = values.map(Date.parse).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}
export function frameUpdatedAt(stream: ObserverStream): number | null {
  const items = traceItems(stream);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "screenshot" && item.at) {
      const stamp = Date.parse(item.at);
      return Number.isFinite(stamp) ? stamp : null;
    }
  }
  return null;
}
export function ageLabel(at: number | null, now = Date.now()): string {
  if (at === null) return "time unavailable";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Only the serving process can grant desktop origin access. It strips persisted
 * markers, adds this one to attached runtime URLs, and refuses to be framed itself. */
export function liveEmbedSandbox(stream: ObserverStream, observerOrigin = window.location.origin): string {
  const url = liveEmbedUrl(stream);
  const trusted = stream.embed?.runtimeDesktop === true;
  if (url && trusted && observerOrigin !== "null" && new URL(url).origin !== observerOrigin) return "allow-scripts allow-same-origin";
  return "allow-scripts";
}
