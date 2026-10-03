#!/usr/bin/env node
// Capture golden run bundles for the built-in studies: the faithfulness oracle for the
// labs-as-config refactor. Run on the pre-refactor commit to lock current behavior, and
// again after the refactor: the new engine must reproduce these (see tests/lab-golden.test.ts).
//
// Goldens are stored raw (with the pinned run-id); normalization (run-id + timestamps +
// durations) happens identically in the test on both sides, so the committed fixture stays
// human-diffable.
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "tests", "golden", "labs");
mkdirSync(outDir, { recursive: true });

// Only deterministic, no-network built-in labs are golden-captured.
const STUDIES = [
  {
    id: "first-run",
    runId: "golden-first-run",
    extra: [],
    artifact: (rid) => `.humanish/runs/${rid}/run.json`,
  },
];

for (const study of STUDIES) {
  console.log(`[golden] capturing ${study.id} ...`);
  // A run id can be used once; clear this script's previous capture of the fixed id.
  rmSync(path.join(root, ".humanish", "runs", study.runId), { recursive: true, force: true });
  execFileSync(
    "pnpm",
    [
      "humanish",
      "--",
      "run",
      study.id,
      ...study.extra,
      "--run-id",
      study.runId,
      "--json",
      "--no-open",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    },
  );
  const src = path.join(root, study.artifact(study.runId));
  if (!existsSync(src)) {
    throw new Error(`[golden] missing artifact for ${study.id}: ${src}`);
  }
  copyFileSync(src, path.join(outDir, `${study.id}.json`));
  console.log(`[golden] wrote tests/golden/labs/${study.id}.json`);
}
console.log("[golden] done");
