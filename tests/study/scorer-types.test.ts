// What RunStudyOptions.scorer accepts. Each `@ts-expect-error` fails typecheck if the line below it
// compiles, so `pnpm typecheck` is the assertion; the runtime test only keeps the file in the suite.

import { describe, expect, it } from "vitest";

import type { BrowserScoringContext } from "../../src/study/adapter-extension.js";
import {
  browserScorer,
  terminalScorer,
  type AdapterScorerModule,
} from "../../src/study/adapter-scorer-loader.js";
import type { TerminalProductScoringContext } from "../../src/routes/terminal/types.js";
import type { RunAdapterScore, RunFeedbackCandidate } from "../../src/run/bundle.js";
import type { RunStudyOptions } from "../../src/run-study.js";

const score = (summary: string): RunAdapterScore => ({
  schema: "humanish.adapter-score.v1",
  namespace: "types",
  status: "pass",
  score: 1,
  summary,
});

/** Inline scorers, scorers typed for one context through its helper, and union scorers compile. */
function accepted(): RunStudyOptions[] {
  const browser = {
    score: (ctx: BrowserScoringContext) => score(`${ctx.route} ${ctx.participantCount}`),
    deriveFeedback: (_ctx: BrowserScoringContext): RunFeedbackCandidate[] => [],
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
  const browser = { score: (ctx: BrowserScoringContext) => score(ctx.route) };
  const mixed = {
    score: (ctx: BrowserScoringContext) => score(ctx.route),
    deriveFeedback: (ctx: TerminalProductScoringContext): RunFeedbackCandidate[] =>
      ctx.transcript ? [] : [],
  };
  return [
    // @ts-expect-error a browser-typed scorer needs browserScorer to say what it was written for
    { cwd: "/x", scorer: browser } satisfies RunStudyOptions,
    // @ts-expect-error a browser score beside a terminal deriveFeedback fits neither helper
    browserScorer(mixed),
    // @ts-expect-error the same module, as a terminal scorer
    terminalScorer(mixed),
  ];
}

describe("RunStudyOptions.scorer", () => {
  it("takes inline scorers, union scorers, and narrowed ones through their helper", () => {
    expect(accepted()).toHaveLength(5);
    expect(refused()).toHaveLength(3);
  });
});
