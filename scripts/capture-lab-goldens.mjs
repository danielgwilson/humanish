#!/usr/bin/env node
// Capture golden run bundles for the built-in labs — the faithfulness oracle for the
// labs-as-config refactor. Run on the pre-refactor commit to lock current behavior, and
// again after the refactor: the new engine must reproduce these (see tests/lab-golden.test.ts).
//
// Goldens are stored RAW (with the pinned run-id); normalization (run-id + timestamps +
// durations) happens identically in the test on both sides, so the committed fixture stays
// human-diffable.
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "tests", "golden", "labs");
mkdirSync(outDir, { recursive: true });

const LABS = [
  { id: "first-run", runId: "golden-first-run", extra: [], artifact: (rid) => `.mimetic/runs/${rid}/run.json` },
  { id: "oss", runId: "golden-oss", extra: ["--dry-run"], artifact: (rid) => `.mimetic/runs/${rid}/run.json` },
  // oss-smoke performs a real shallow clone even under --dry-run; its golden is the result
  // envelope shape (schema/repos/steps/changedFiles), normalized. Live-clone faithfulness is
  // a rung-4/5 concern, not this deterministic oracle.
  { id: "oss-smoke", runId: "golden-oss-smoke", extra: ["--dry-run"], artifact: (rid) => `.mimetic/lab/oss/${rid}/report.json` }
];

for (const lab of LABS) {
  console.log(`[golden] capturing ${lab.id} ...`);
  execFileSync("pnpm", ["mimetic", "--", "lab", "run", lab.id, ...lab.extra, "--run-id", lab.runId, "--json", "--no-open"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CI: "true" }
  });
  const src = path.join(root, lab.artifact(lab.runId));
  if (!existsSync(src)) {
    throw new Error(`[golden] missing artifact for ${lab.id}: ${src}`);
  }
  copyFileSync(src, path.join(outDir, `${lab.id}.json`));
  console.log(`[golden] wrote tests/golden/labs/${lab.id}.json`);
}
console.log("[golden] done");
