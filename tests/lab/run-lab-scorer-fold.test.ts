import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { runLab, type InternalRunLabOptions } from "../../src/run-lab.js";
import type { LabConfig } from "../../src/lab/types.js";
import type { RunAdapterScore, RunScorerProvenance } from "../../src/run/bundle.js";
import { lab } from "../admission/fixtures.js";
import type { LabDeps } from "../../src/lab/lab-deps.js";
import { passingRun, terminalConfig } from "../helpers/terminal-live-fake.js";

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
  /** The run's options: dry run, or the fake live terminal. */
  base: () => Partial<InternalRunLabOptions>;
  /** The route's test seams, where it has them outside a bag. */
  deps?: () => LabDeps;
}

const routes: Record<string, Route> = {
  "computer use": {
    config: () => parsed("cuAppUrl"),
    base: () => ({ dryRun: true }),
  },
  "shared world": {
    config: () => parsed("sharedProvisioned"),
    base: () => ({ dryRun: true }),
  },
  terminal: {
    config: () => terminalConfig(),
    base: () => ({ dryRun: false, env: passingRun().env! }),
    deps: () => passingRun().deps!,
  },
};

// The route folds scorer failures into its judged verdict once, before the run finishes, so the
// bundle, status.json and the result agree. A browser route fails on any valid fail score and on a
// declared scorer that throws or returns a malformed value; the terminal route fails only on a
// declared scorer. Without a failure the judged verdict stands: a contract for the dry browser
// runs, a pass for the fake live terminal run.
describe("scorer failures fold into one verdict the bundle, status and result agree on", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const judged: Record<string, string> = {
    "computer use": "contract_proof_only",
    "shared world": "contract_proof_only",
    terminal: "pass",
  };
  const fails = (routeName: string, behavior: string, declared: boolean): boolean =>
    routeName === "terminal"
      ? declared && behavior !== "valid pass"
      : behavior === "valid fail" || (declared && behavior !== "valid pass");

  for (const [routeName, route] of Object.entries(routes)) {
    for (const behavior of Object.keys(behaviors)) {
      for (const declared of [false, true]) {
        it(`${routeName}: ${behavior}${declared ? " with CLI provenance" : ""}`, async () => {
          const cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-fold-"));
          dirs.push(cwd);
          const outcome = await runLab(
            route.config(),
            {
              ...route.base(),
              scorer: { score: behaviors[behavior]! },
              ...(declared ? { scorerProvenance: provenance } : {}),
              cwd,
              runId: "fold",
            } as InternalRunLabOptions,
            route.deps?.(),
          );
          const runDir = path.join(cwd, ".humanish", "runs", "fold");
          const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as {
            review: { verdict: string; gaps: string[] };
          };
          const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
            outcome?: { verdict?: string; ok?: boolean };
          };
          const failed = fails(routeName, behavior, declared);
          expect(bundle.review.verdict).toBe(failed ? "fail" : judged[routeName]);
          expect(status.outcome?.verdict).toBe(bundle.review.verdict);
          expect(outcome.result.ok).toBe(!failed);
          expect(status.outcome?.ok).toBe(outcome.result.ok);
        });
      }
    }
  }
});
