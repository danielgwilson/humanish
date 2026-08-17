import { describe, expect, it } from "vitest";

import { formatDuration, runArtifactHref } from "../lib/artifact-href";
import { fetchHistoryIndex, fetchObserverData, followTarget, liveEmbedUrl } from "../lib/live";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import { buildPlayerModel, frameHoldMs, parseClickCoord } from "../lib/player-model";
import { formatHash, parseHash } from "../lib/route";
import { NOTABLE_COMPLETION } from "../lib/signal";
import { buildTally } from "../components/study-grid";

describe("runArtifactHref containment", () => {
  it("prefixes run-root-relative paths for the observer/ vantage point", () => {
    expect(runArtifactHref("screenshots/lane/turn-01.png")).toBe("../screenshots/lane/turn-01.png");
  });

  it("refuses absolute paths, traversal, schemes, and data URIs", () => {
    expect(runArtifactHref("/etc/passwd")).toBeNull();
    expect(runArtifactHref("../secret.txt")).toBeNull();
    expect(runArtifactHref("shots/../../secret.txt")).toBeNull();
    expect(runArtifactHref("https://example.com/x.png")).toBeNull();
    expect(runArtifactHref("data:image/png;base64,AAAA")).toBeNull();
    expect(runArtifactHref("")).toBeNull();
  });
});

describe("notable completions", () => {
  it("covers every non-clean ActorCompletionReason and nothing clean", () => {
    expect(Object.keys(NOTABLE_COMPLETION).sort()).toEqual([
      "actor_error",
      "blocked_approval",
      "budget_reached",
      "gave_up",
      "harness_error",
      "step_failed",
      "timed_out"
    ]);
    expect(NOTABLE_COMPLETION["goal_satisfied"]).toBeUndefined();
    expect(NOTABLE_COMPLETION["turn_completed"]).toBeUndefined();
  });
});

describe("hash routes (#441 deep links)", () => {
  it("round-trips lane and frame addresses, 1-based in the hash", () => {
    expect(parseHash(formatHash("stream-001", null))).toEqual({ laneId: "stream-001", frame: null });
    expect(parseHash(formatHash("stream-001", 0))).toEqual({ laneId: "stream-001", frame: 0 });
    expect(formatHash("stream-001", 2)).toBe("#/lane/stream-001/f/3");
    expect(parseHash("#/lane/stream-001/f/3")).toEqual({ laneId: "stream-001", frame: 2 });
  });

  it("resolves anything unaddressable to the grid, never an error", () => {
    expect(parseHash("")).toEqual({ laneId: null, frame: null });
    expect(parseHash("#")).toEqual({ laneId: null, frame: null });
    expect(parseHash("#/lane/")).toEqual({ laneId: null, frame: null });
    expect(parseHash("#/lane/x/f/0")).toEqual({ laneId: "x", frame: null });
    expect(parseHash("#/lane/x/f/junk")).toEqual({ laneId: null, frame: null });
    expect(parseHash("#focus=legacy")).toEqual({ laneId: null, frame: null });
    expect(formatHash(null, 5)).toBe("");
  });

  it("escapes lane ids that need it", () => {
    const round = parseHash(formatHash("lane/with slash", 0));
    expect(round.laneId).toBe("lane/with slash");
  });
});

describe("player model", () => {
  function streamWith(items: unknown[], durationMs = 20_000): ObserverStream {
    return { actor: { items, durationMs } } as unknown as ObserverStream;
  }

  it("parses recorded click coordinates from action titles, nothing else", () => {
    expect(parseClickCoord("click (700, 420)")).toEqual({ x: 700, y: 420 });
    expect(parseClickCoord("double-click (10, 20)")).toEqual({ x: 10, y: 20 });
    expect(parseClickCoord("keypress TAB")).toBeNull();
    expect(parseClickCoord("click somewhere")).toBeNull();
  });

  it("associates each row with the most recent frame, clamping pre-frame actions to 0", () => {
    const model = buildPlayerModel(
      streamWith([
        { id: "a0", kind: "ui_action", lifecycle: "completed", title: "wait" },
        { id: "s0", kind: "screenshot", lifecycle: "completed", title: "turn-00", screenshotRef: { path: "shots/t0.png", redaction: "none" } },
        { id: "a1", kind: "ui_action", lifecycle: "completed", title: "click (5, 6)" },
        { id: "s1", kind: "screenshot", lifecycle: "completed", title: "turn-01", screenshotRef: { path: "shots/t1.png", redaction: "none" } }
      ])
    );
    expect(model).not.toBeNull();
    expect(model?.frames.map((f) => f.href)).toEqual(["../shots/t0.png", "../shots/t1.png"]);
    expect(model?.rows.map((r) => r.frameIndex)).toEqual([0, 0, 0, 1]);
    expect(model?.rows[2]?.coord).toEqual({ x: 5, y: 6 });
    expect(model?.avgFrameMs).toBe(10_000);
  });

  it("builds from the mid-run liveActor partial when no finished actor exists (#441)", () => {
    const stream = {
      liveActor: {
        schema: "humanish.live-actor.v1",
        updatedAt: "2026-08-17T00:00:00.000Z",
        items: [
          { id: "s0", kind: "screenshot", lifecycle: "completed", title: "turn-00", screenshotRef: { path: "shots/t0.png", redaction: "none" } },
          { id: "a1", kind: "ui_action", lifecycle: "completed", title: "click (5, 6)", coord: { x: 5, y: 6 } }
        ]
      }
    } as unknown as ObserverStream;
    const model = buildPlayerModel(stream);
    expect(model).not.toBeNull();
    expect(model?.frames).toHaveLength(1);
    expect(model?.rows[1]?.coord).toEqual({ x: 5, y: 6 });
  });

  it("recorded pacing (#441): stamped frames play at real intervals, unstamped fall back to avg", () => {
    const stamped = buildPlayerModel(
      streamWith([
        { id: "s0", kind: "screenshot", lifecycle: "completed", title: "t0", at: "2026-08-17T00:00:00.000Z", screenshotRef: { path: "shots/t0.png", redaction: "none" } },
        { id: "s1", kind: "screenshot", lifecycle: "completed", title: "t1", at: "2026-08-17T00:00:03.500Z", screenshotRef: { path: "shots/t1.png", redaction: "none" } },
        { id: "s2", kind: "screenshot", lifecycle: "completed", title: "t2", at: "2026-08-17T00:00:04.000Z", screenshotRef: { path: "shots/t2.png", redaction: "none" } }
      ])
    );
    expect(stamped?.paced).toBe("recorded");
    expect(frameHoldMs(stamped!, 0)).toBe(3500);
    expect(frameHoldMs(stamped!, 1)).toBe(500);

    const unstamped = buildPlayerModel(
      streamWith([
        { id: "s0", kind: "screenshot", lifecycle: "completed", title: "t0", screenshotRef: { path: "shots/t0.png", redaction: "none" } },
        { id: "s1", kind: "screenshot", lifecycle: "completed", title: "t1", at: "2026-08-17T00:00:01.000Z", screenshotRef: { path: "shots/t1.png", redaction: "none" } }
      ], 10_000)
    );
    expect(unstamped?.paced).toBe("avg");
    expect(frameHoldMs(unstamped!, 0)).toBe(5000);
  });

  it("returns null for a lane with no frames", () => {
    expect(buildPlayerModel(streamWith([{ id: "a", kind: "ui_action", lifecycle: "completed", title: "wait" }]))).toBeNull();
    expect(buildPlayerModel({} as unknown as ObserverStream)).toBeNull();
  });
});

describe("live helpers", () => {
  const stream = (over: object): ObserverStream => over as unknown as ObserverStream;

  it("followTarget follows the live edge only from the newest frame", () => {
    expect(followTarget(4, 5, 8)).toBe(7); // viewer at last frame → follow growth
    expect(followTarget(2, 5, 8)).toBe(2); // scrubbed back → instant replay stays
    expect(followTarget(4, 5, 5)).toBe(4); // no growth → no move
    expect(followTarget(9, 10, 3)).toBe(2); // shrink clamps into range
  });

  it("liveEmbedUrl honors the injected URL and the #357 ended flag", () => {
    expect(liveEmbedUrl(stream({ embed: { kind: "iframe", url: "https://live.example/d" } }))).toBe("https://live.example/d");
    expect(liveEmbedUrl(stream({ embed: { kind: "iframe", url: "https://live.example/d" }, liveEnded: true }))).toBeNull();
    expect(liveEmbedUrl(stream({ embed: { kind: "screenshot", url: "shot.png" } }))).toBeNull();
    expect(liveEmbedUrl(stream({}))).toBeNull();
  });

  it("fetchObserverData accepts only ok responses carrying the schema", async () => {
    const ok = (body: unknown) =>
      (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
    expect(await fetchObserverData(ok({ schema: "humanish.observer-data.v1", streams: [] }))).not.toBeNull();
    expect(await fetchObserverData(ok({ schema: "something.else" }))).toBeNull();
    expect(await fetchObserverData((async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull();
    expect(
      await fetchObserverData((async () => {
        throw new Error("network");
      }) as unknown as typeof fetch)
    ).toBeNull();
  });

  it("fetchHistoryIndex parses valid rows and skips malformed ones", async () => {
    const impl = (async () => ({
      ok: true,
      json: async () => ({
        latestRunId: "a",
        runs: [
          { runId: "a", href: "/_humanish/runs/a/observer/index.html", status: "pass", mode: "live", streamCount: 2 },
          { nope: true },
          { runId: "b", href: "/_humanish/runs/b/observer/index.html" }
        ]
      })
    })) as unknown as typeof fetch;
    const index = await fetchHistoryIndex(impl);
    expect(index?.latestRunId).toBe("a");
    expect(index?.runs.map((run) => run.runId)).toEqual(["a", "b"]);
    expect(index?.runs[1]?.status).toBe("unknown");
    expect(await fetchHistoryIndex((async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatDuration(191_864)).toBe("3m 12s");
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(9_400)).toBe("9s");
  });
});

describe("buildTally cost line", () => {
  const base = {
    run: { mode: "live" },
    summary: { streams: 2, active: 0, blocked: 0, warnings: 0 }
  };

  it("a declared-null run cost reads 'cost not estimated', never silence (legacy intent, migrated at cutover)", () => {
    const withNull = {
      ...base,
      cost: { estimatedTotalUsd: null, ratesAsOf: "2026-08-01", placeholder: true }
    } as unknown as ObserverData;
    expect(buildTally(withNull)).toContain("cost not estimated");
  });

  it("an absent cost block stays silent (dry-run: nothing was spent, nothing is claimed)", () => {
    expect(buildTally(base as unknown as ObserverData)).not.toContain("cost");
  });
});
