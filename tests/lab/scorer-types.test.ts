// What RunLabOptions.scorer accepts. Each `@ts-expect-error` fails typecheck if the line below it
// compiles, so `pnpm typecheck` is the assertion; the runtime test only keeps the file in the suite.

import { describe, expect, it } from "vitest";

import type { BrowserLabScoringContext } from "../../src/lab/adapter-extension.js";
import type { AdapterScorerModule } from "../../src/lab/adapter-scorer-loader.js";
import type { TerminalProductScoringContext } from "../../src/routes/terminal/types.js";
import type { RunAdapterScore, RunFeedbackCandidate } from "../../src/run/bundle.js";
import type { RunLabOptions } from "../../src/run-lab.js";

const score = (summary: string): RunAdapterScore => ({
  schema: "humanish.adapter-score.v1",
  namespace: "types",
  status: "pass",
  score: 1,
  summary,
});

/** Scorers typed for one context, or for both, assign without a cast. */
function accepted(): RunLabOptions[] {
  const browser = {
    score: (ctx: BrowserLabScoringContext) => score(`${ctx.backend} ${ctx.laneCount}`),
    deriveFeedback: (_ctx: BrowserLabScoringContext): RunFeedbackCandidate[] => [],
  };
  const terminal = {
    score: (ctx: TerminalProductScoringContext) => score(ctx.transcript),
  };
  const either: AdapterScorerModule = {
    score: (ctx) => score("backend" in ctx ? ctx.backend : ctx.transcript),
  };
  return [
    { cwd: "/x", scorer: browser },
    { cwd: "/x", scorer: terminal },
    { cwd: "/x", scorer: either },
    { cwd: "/x", scorer: { score: (ctx: BrowserLabScoringContext) => score(ctx.runDir) } },
  ];
}

/** A module whose functions read different contexts fits no route, so it is refused. */
function refused(): unknown[] {
  const mixed = {
    score: (ctx: BrowserLabScoringContext) => score(ctx.backend),
    deriveFeedback: (ctx: TerminalProductScoringContext): RunFeedbackCandidate[] =>
      ctx.transcript ? [] : [],
  };
  return [
    // @ts-expect-error a browser score beside a terminal deriveFeedback
    { cwd: "/x", scorer: mixed } satisfies RunLabOptions,
  ];
}

describe("RunLabOptions.scorer", () => {
  it("takes a scorer typed for either context, or for both", () => {
    expect(accepted()).toHaveLength(4);
    expect(refused()).toHaveLength(1);
  });
});
