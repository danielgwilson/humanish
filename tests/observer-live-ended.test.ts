import { describe, expect, it } from "vitest";

// #357: a finished/cleaned-up lane must fall back to recorded evidence, never render the dead
// stream. The overlay is where that decision lives: an ENDED runtime entry stops injecting its
// live URL and marks the stream so the page can say why the live view changed.
import { withRuntimeStreamUrls, type ObserverRuntimeStreamUrl } from "../src/observer.js";
import type { ObserverData } from "../src/observer-data.js";

function observerData(): ObserverData {
  return {
    schema: "humanish.observer-data.v1",
    run: { runId: "run-1", status: "running" },
    streams: [
      { id: "stream-a", label: "Lane A", status: "running" },
      { id: "stream-b", label: "Lane B", status: "passed" },
      { id: "stream-c", label: "Lane C", status: "running" }
    ]
  } as unknown as ObserverData;
}

describe("withRuntimeStreamUrls lifecycle (#357)", () => {
  it("injects live iframes for active streams, falls back (liveEnded) for ended ones, leaves the rest untouched", () => {
    const runtime: ObserverRuntimeStreamUrl[] = [
      { streamId: "stream-a", url: "https://live.example.test/a" },
      { streamId: "stream-b", url: "https://live.example.test/b", ended: true }
    ];
    const merged = withRuntimeStreamUrls(observerData(), runtime);
    const [a, b, c] = merged.streams as unknown as Array<Record<string, unknown>>;

    // Active lane: the live iframe rides in.
    expect((a!.embed as Record<string, unknown>).kind).toBe("iframe");
    expect((a!.embed as Record<string, unknown>).url).toBe("https://live.example.test/a");
    expect(a!.liveEnded).toBeUndefined();

    // Ended lane: NO dead URL is served — the tile renders its recorded evidence — and the page
    // is told why, so "finished" can never read as "sandbox not found".
    expect(b!.embed).toBeUndefined();
    expect(b!.url).toBeUndefined();
    expect(b!.liveEnded).toBe(true);

    // A stream with no runtime entry stays byte-identical.
    expect(c).toEqual({ id: "stream-c", label: "Lane C", status: "running" });
  });

  it("marking an entry ended after attach flips only that stream on the next merge", () => {
    const runtime: ObserverRuntimeStreamUrl[] = [
      { streamId: "stream-a", url: "https://live.example.test/a" },
      { streamId: "stream-b", url: "https://live.example.test/b" }
    ];
    const before = withRuntimeStreamUrls(observerData(), runtime);
    expect((before.streams[1] as unknown as Record<string, unknown>).liveEnded).toBeUndefined();

    runtime[1]!.ended = true; // the lane's teardown fired onRuntimeStreamEnded
    const after = withRuntimeStreamUrls(observerData(), runtime);
    expect((after.streams[0] as unknown as Record<string, unknown>).liveEnded).toBeUndefined();
    expect((after.streams[1] as unknown as Record<string, unknown>).liveEnded).toBe(true);
    expect((after.streams[1] as unknown as Record<string, unknown>).embed).toBeUndefined();
  });
});
