import { traceItems } from "./artifact-href";
import type { ObserverStream } from "./observer-data";

/** Two clicks can share a title, image and even a timestamp. Keep saved choices
 * distinguishable without storing copied trace text in browser preferences. */
export function savedEntryLabels(streams: ObserverStream[]): Map<string, string> {
  return new Map(streams.flatMap((stream) => traceItems(stream).map((item, index) => {
    const atMs = item.at === undefined ? Number.NaN : Date.parse(item.at);
    const stamp = Number.isFinite(atMs) ? `${new Date(atMs).toISOString().slice(11, -1)} UTC` : "time unavailable";
    return [`${stream.id}/${item.id}`, `${item.title} · ${stamp} · entry ${index + 1}`] as const;
  })));
}
