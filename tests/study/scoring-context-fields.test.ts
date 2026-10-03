import { afterEach, describe, expect, it, vi } from "vitest";

import { applyBrowserScorer, type BrowserScorer } from "../../src/study/adapter-extension.js";
import type { BrowserScoringContext, RunBundle } from "../../src/index.js";

const bundle = (): RunBundle =>
  ({
    review: { verdict: "pass", summary: "ok", gaps: [] as string[] },
    feedbackCandidates: [],
    noSpend: { satisfied: false },
  }) as unknown as RunBundle;

/** Runs a scorer whose three hooks each call `read` on the context, and returns what it read. */
async function readThroughScorer(
  route: "computer-use" | "shared-world",
  read: (ctx: BrowserScoringContext) => unknown,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const scorer: BrowserScorer = {
    score: (ctx) => {
      seen.push(read(ctx));
      return {
        schema: "humanish.adapter-score.v1",
        namespace: "fields",
        status: "pass",
        score: 1,
        summary: "ok",
      };
    },
    deriveFeedback: (ctx) => {
      seen.push(read(ctx));
      return [];
    },
    deriveArtifacts: (ctx) => {
      seen.push(read(ctx));
      return [];
    },
  };
  const current = bundle();
  await applyBrowserScorer({
    scorer,
    bundle: current,
    context: {
      bundle: current,
      runDir: "/ignored/runDir",
      labId: "lab",
      runId: "run",
      actor: "openai-computer-use",
      route,
      dryRun: true,
      participantCount: 3,
    },
    sanitize: (text) => text,
    warnings: [],
  });
  return seen;
}

const deprecations = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
  spy.mock.calls.filter(
    ([, options]) => (options as { type?: unknown } | undefined)?.type === "DeprecationWarning",
  );

describe("BrowserScoringContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a scorer participantCount and route without a warning", async () => {
    const spy = vi.spyOn(process, "emitWarning");

    expect(
      await readThroughScorer("computer-use", (ctx) => [ctx.route, ctx.participantCount]),
    ).toEqual([
      ["computer-use", 3],
      ["computer-use", 3],
      ["computer-use", 3],
    ]);
    expect(await readThroughScorer("shared-world", (ctx) => ctx.route)).toEqual([
      "shared-world",
      "shared-world",
      "shared-world",
    ]);
    expect(deprecations(spy)).toEqual([]);
  });

  it("has no backend or laneCount, which 0.109.0 removed", async () => {
    const spy = vi.spyOn(process, "emitWarning");

    const [copies] = await readThroughScorer("computer-use", (ctx) => ({
      spread: { ...ctx },
      assigned: Object.assign({}, ctx),
      json: JSON.parse(JSON.stringify(ctx)) as Record<string, unknown>,
      cloned: structuredClone(ctx),
      keys: Object.keys(ctx),
      declared: "laneCount" in ctx || "backend" in ctx,
    }));

    const { spread, assigned, json, cloned, keys, declared } = copies as {
      spread: Record<string, unknown>;
      assigned: Record<string, unknown>;
      json: Record<string, unknown>;
      cloned: Record<string, unknown>;
      keys: string[];
      declared: boolean;
    };
    for (const copy of [spread, assigned, json, cloned]) {
      expect(copy).toMatchObject({ route: "computer-use", participantCount: 3 });
      expect(copy).not.toHaveProperty("laneCount");
      expect(copy).not.toHaveProperty("backend");
    }
    expect(keys).not.toContain("laneCount");
    expect(keys).not.toContain("backend");
    expect(declared).toBe(false);
    expect(deprecations(spy)).toEqual([]);
  });
});
