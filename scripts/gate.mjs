#!/usr/bin/env node
// `pnpm gate`: runs the CI-required checks that can run locally on HEAD's tree, then records a
// pass that .githooks/pre-push looks for. The contributing guide lists what it runs and what it
// leaves to CI.
import { spawnSync } from "node:child_process";

import { planGate, runGate } from "./lib/gate.mjs";

const BASE = "origin/main";

/**
 * Paths changed between the merge-base with origin/main and HEAD, or undefined when no merge-base
 * resolves. Renames list both paths, so a file moved out of site/ still counts as a site change.
 */
function changedPaths() {
  const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
  const base = git("merge-base", "HEAD", BASE);
  if (base.status !== 0) return undefined;
  const diff = git("diff", "--name-only", "--no-renames", "-z", base.stdout.trim(), "HEAD");
  if (diff.status !== 0) return undefined;
  return diff.stdout.split("\0").filter(Boolean);
}

const write = (text) => process.stdout.write(text);
const paths = changedPaths();
write(
  paths === undefined
    ? `gate: no merge-base with ${BASE}, so every stage runs.\n`
    : `gate: ${paths.length} paths changed since the merge-base with ${BASE}.\n`,
);
try {
  process.exitCode = await runGate({
    cwd: process.cwd(),
    plan: planGate(paths, process.env),
    write,
  });
} catch (error) {
  process.stderr.write(`gate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
