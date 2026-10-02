import { afterEach, describe, expect, it, vi } from "vitest";

import { applyBrowserScorer, type BrowserScorer } from "../../src/lab/adapter-extension.js";
import type { BrowserLabScoringContext, RunBundle } from "../../src/index.js";
import { allowDeprecationsInThisTest } from "../helpers/deprecations.js";

const CODE = "HUMANISH_SCORING_CONTEXT_FIELD_DEPRECATED";

const bundle = (): RunBundle =>
  ({
    review: { verdict: "pass", summary: "ok", gaps: [] as string[] },
    feedbackCandidates: [],
    noSpend: { satisfied: false },
  }) as unknown as RunBundle;

/** Runs a scorer whose three hooks each call `read` on the context, and returns what it read. */
async function readThroughScorer(
  route: "computer-use" | "shared-world",
  read: (ctx: BrowserLabScoringContext) => unknown,
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

const deprecationCodes = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls
    .map(([, options]) => (options as { code?: unknown } | undefined)?.code)
    .filter((code) => code === CODE);

describe("BrowserLabScoringContext", () => {
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
    expect(deprecationCodes(spy)).toEqual([]);
  });

  it("still fills laneCount and backend, and warns once per field", async () => {
    allowDeprecationsInThisTest(CODE, "reads the deprecated fields on purpose");
    const spy = vi.spyOn(process, "emitWarning");

    const computerUse = await readThroughScorer("computer-use", (ctx) => [
      ctx.backend,
      ctx.laneCount,
      Object.keys(ctx).includes("laneCount") && Object.keys(ctx).includes("backend"),
    ]);
    const sharedWorld = await readThroughScorer("shared-world", (ctx) => ctx.backend);

    expect(computerUse).toEqual([
      ["cua", 3, true],
      ["cua", 3, true],
      ["cua", 3, true],
    ]);
    expect(sharedWorld).toEqual([
      "concurrent-shared-world",
      "concurrent-shared-world",
      "concurrent-shared-world",
    ]);
    expect(deprecationCodes(spy)).toEqual([CODE, CODE]);
    expect(spy.mock.calls.map(([message]) => message)).toEqual([
      "BrowserLabScoringContext.backend is deprecated and is removed in the next minor. Use route.",
      "BrowserLabScoringContext.laneCount is deprecated and is removed in the next minor. Use participantCount.",
    ]);
  });
});
