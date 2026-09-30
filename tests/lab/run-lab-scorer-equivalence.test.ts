import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { runLab, type RunLabOptions } from "../../src/lab/engine.js";
import type { LabConfig } from "../../src/lab/types.js";
import type { RunAdapterScore, RunScorerProvenance } from "../../src/run/bundle.js";
import { lab } from "../admission/fixtures.js";
import { passingHooks, terminalConfig } from "../helpers/terminal-live-fake.js";

// RunLabOptions.scorer is the legacy scorer hook under a new name: for each route and each scorer
// behavior, with and without CLI provenance, the review, the adapter score, the result and its
// warnings match the run that passed the same function through the route's hook bag.

type Score = () => RunAdapterScore;

const behaviors: Record<string, Score> = {
  "valid pass": () => ({
    schema: "humanish.adapter-score.v1",
    namespace: "equivalence",
    status: "pass",
    score: 90,
    summary: "rubric passed",
  }),
  "valid fail": () => ({
    schema: "humanish.adapter-score.v1",
    namespace: "equivalence",
    status: "fail",
    score: 10,
    summary: "rubric failed",
  }),
  throw: () => {
    throw new Error("scorer boom");
  },
  malformed: () => ({ schema: "not-an-adapter-score" }) as unknown as RunAdapterScore,
};

const provenance: RunScorerProvenance = {
  schema: "humanish.scorer-provenance.v1",
  ref: "scorers/equivalence.mjs",
  digest: "0123456789ab",
  source: "cli-flag",
  exports: ["score"],
};

function parsed(base: "cuAppUrl" | "sharedProvisioned"): LabConfig {
  const result = parseLabConfig(lab(base));
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

interface Route {
  config: () => LabConfig;
  /** Options both runs share: dry run or the fake live terminal. */
  base: () => Partial<RunLabOptions>;
  /** The same scorer through the route's legacy hook bag. */
  legacy: (score: Score) => Partial<RunLabOptions>;
}

const routes: Record<string, Route> = {
  "computer use": {
    config: () => parsed("cuAppUrl"),
    base: () => ({ dryRun: true }),
    legacy: (score) => ({ cuaHooks: { score } }),
  },
  "shared world": {
    config: () => parsed("sharedProvisioned"),
    base: () => ({ dryRun: true }),
    legacy: (score) => ({ sharedWorldHooks: { score } }),
  },
  terminal: {
    config: () => terminalConfig(),
    base: () => ({ dryRun: false, terminalHooks: passingHooks({}) }),
    legacy: (score) => ({ dryRun: false, terminalHooks: passingHooks({ score }) }),
  },
};

describe("RunLabOptions.scorer matches the legacy scorer hook", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    dirs.length = 0;
  });
  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function evidence(route: Route, options: Partial<RunLabOptions>) {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-equivalence-"));
    dirs.push(cwd);
    const outcome = await runLab(route.config(), {
      ...route.base(),
      ...options,
      cwd,
      runId: "equivalence",
    } as RunLabOptions);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "equivalence", "run.json"), "utf8"),
    ) as { review: unknown; adapterScore?: RunAdapterScore; scorerProvenance?: unknown };
    const text = JSON.stringify({
      ok: outcome.result.ok,
      warnings: outcome.result.warnings,
      review: bundle.review,
      adapterScore: bundle.adapterScore,
      scorerProvenance: bundle.scorerProvenance,
    });
    return JSON.parse(text.split(cwd).join("[cwd]")) as {
      ok: boolean;
      adapterScore?: RunAdapterScore;
    };
  }

  for (const [routeName, route] of Object.entries(routes)) {
    for (const [behavior, score] of Object.entries(behaviors)) {
      for (const declared of [false, true]) {
        it(`${routeName}: ${behavior}${declared ? " with CLI provenance" : ""}`, async () => {
          const withProvenance = declared ? { scorerProvenance: provenance } : {};
          const viaHome = await evidence(route, { scorer: { score }, ...withProvenance });
          const viaHook = await evidence(route, { ...route.legacy(score), ...withProvenance });

          expect(viaHome).toEqual(viaHook);
          if (behavior === "valid pass") expect(viaHome.adapterScore?.status).toBe("pass");
        });
      }
    }
  }
});
