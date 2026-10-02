// What RunLabOptions.scorer accepts. Each `@ts-expect-error` fails typecheck if the line below it
// compiles, so `pnpm typecheck` is the assertion; the runtime test only keeps the file in the suite.

import { describe, expect, it } from "vitest";

import type { BrowserLabScoringContext } from "../../src/lab/adapter-extension.js";
import {
  browserScorer,
  terminalScorer,
  type AdapterScorerModule,
} from "../../src/lab/adapter-scorer-loader.js";
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

/** Inline scorers, scorers typed for one context through its helper, and union scorers compile. */
function accepted(): RunLabOptions[] {
  const browser = {
    score: (ctx: BrowserLabScoringContext) => score(`${ctx.route} ${ctx.participantCount}`),
    deriveFeedback: (_ctx: BrowserLabScoringContext): RunFeedbackCandidate[] => [],
  };
  const terminal = {
    score: (ctx: TerminalProductScoringContext) => score(ctx.transcript),
  };
  const either: AdapterScorerModule = {
    score: (ctx) => score("route" in ctx ? ctx.route : ctx.transcript),
  };
  return [
    { cwd: "/x", scorer: browserScorer(browser) },
    { cwd: "/x", scorer: terminalScorer(terminal) },
    { cwd: "/x", scorer: either },
    // Inline literals keep their contextual types: a literal schema and a typed ctx.
    {
      cwd: "/x",
      scorer: {
        score: () => ({
          schema: "humanish.adapter-score.v1",
          namespace: "n",
          status: "pass",
          score: 1,
          summary: "s",
        }),
      },
    },
    { cwd: "/x", scorer: { score: (ctx) => score(ctx.runId) } },
  ];
}

/** A scorer typed for one context, passed bare or mixed with the other, is refused. */
function refused(): unknown[] {
  const browser = { score: (ctx: BrowserLabScoringContext) => score(ctx.route) };
  const mixed = {
    score: (ctx: BrowserLabScoringContext) => score(ctx.route),
    deriveFeedback: (ctx: TerminalProductScoringContext): RunFeedbackCandidate[] =>
      ctx.transcript ? [] : [],
  };
  return [
    // @ts-expect-error a browser-typed scorer needs browserScorer to say what it was written for
    { cwd: "/x", scorer: browser } satisfies RunLabOptions,
    // @ts-expect-error a browser score beside a terminal deriveFeedback fits neither helper
    browserScorer(mixed),
    // @ts-expect-error the same module, as a terminal scorer
    terminalScorer(mixed),
  ];
}

describe("RunLabOptions.scorer", () => {
  it("takes inline scorers, union scorers, and narrowed ones through their helper", () => {
    expect(accepted()).toHaveLength(5);
    expect(refused()).toHaveLength(3);
  });
});
