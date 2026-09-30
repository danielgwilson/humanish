#!/usr/bin/env node
// Capture golden run bundles for the built-in labs — the faithfulness oracle for the
// labs-as-config refactor. Run on the pre-refactor commit to lock current behavior, and
// again after the refactor: the new engine must reproduce these (see tests/lab-golden.test.ts).
//
// Goldens are stored RAW (with the pinned run-id); normalization (run-id + timestamps +
// durations) happens identically in the test on both sides, so the committed fixture stays
// human-diffable.
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "tests", "golden", "labs");
mkdirSync(outDir, { recursive: true });

// Only deterministic, no-network built-in labs are golden-captured.
const LABS = [
  {
    id: "first-run",
    runId: "golden-first-run",
    extra: [],
    artifact: (rid) => `.humanish/runs/${rid}/run.json`,
  },
];

for (const lab of LABS) {
  console.log(`[golden] capturing ${lab.id} ...`);
  // A run id can be used once; clear this script's previous capture of the fixed id.
  rmSync(path.join(root, ".humanish", "runs", lab.runId), { recursive: true, force: true });
  execFileSync(
    "pnpm",
    [
      "humanish",
      "--",
      "lab",
      "run",
      lab.id,
      ...lab.extra,
      "--run-id",
      lab.runId,
      "--json",
      "--no-open",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    },
  );
  const src = path.join(root, lab.artifact(lab.runId));
  if (!existsSync(src)) {
    throw new Error(`[golden] missing artifact for ${lab.id}: ${src}`);
  }
  copyFileSync(src, path.join(outDir, `${lab.id}.json`));
  console.log(`[golden] wrote tests/golden/labs/${lab.id}.json`);
}
console.log("[golden] done");
