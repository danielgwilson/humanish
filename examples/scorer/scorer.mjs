// @ts-check
// A scorer module: humanish calls `score` over the finished evidence of a computer-use,
// shared-world or terminal run and stores the result, under your namespace, as
// `bundle.adapterScore`. The same file works with `humanish lab run <lab> --scorer scorer.mjs` and,
// from a library caller, as the scorer hooks passed to `runStudy`.

/** @type {NonNullable<import("humanish").AdapterScorerModule["score"]>} */
export function score(ctx) {
  const participants = ctx.bundle.streams.length;
  const dryRun = ctx.bundle.mode === "dry-run";
  return {
    schema: "humanish.adapter-score.v1",
    namespace: "example-scorer",
    // A dry run has no participant behavior to judge, so this rubric withholds a pass.
    status: dryRun ? "partial" : "pass",
    score: dryRun ? 50 : 100,
    summary: `${participants} participant stream(s) in ${ctx.labId}${dryRun ? " (dry run)" : ""}.`,
    data: { participants, runId: ctx.runId },
  };
}
