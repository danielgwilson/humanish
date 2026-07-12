import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runLab } from "../src/lab-engine.js";
import { resolveLabManifest } from "../src/labs.js";

// RUNG 2 (faithfulness): the v2 config + one-engine path must reproduce the pre-refactor run
// bundles captured by scripts/capture-lab-goldens.mjs. We pin the same run-id as the golden so
// only timestamps vary; normalizeTimestamps removes those. The bundle already redacts cwd to a
// stable placeholder, so the comparison is environment-independent.
//
// first-run (synthetic) and oss (meta) are deterministic in dry-run. oss-smoke performs a real
// network clone even in dry-run, so its live-clone faithfulness is a rung-4/5 concern, not this
// deterministic gate.

const ROOT = process.cwd();

// Normalize the two ambient, non-behavioral parts of a run bundle: ISO timestamps and the
// captured git working-tree state. The git-state subtree (status/sha/refState/change-counts) is
// 100% environment-dependent — it differs between a local worktree (attached HEAD) and a CI PR
// checkout (detached HEAD) — and is NOT part of what this refactor must preserve. We mask every
// LEAF VALUE inside it while keeping its STRUCTURE (keys) asserted, so a structural regression in
// that subtree still fails the test but ambient values never make the golden flaky.
function normalizeBundle(value: unknown, inGitState = false): unknown {
  if (inGitState && (value === null || typeof value !== "object")) {
    return "[git]";
  }
  if (typeof value === "string") {
    return value.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "[ts]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBundle(entry, inGitState));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nowInGitState = inGitState || obj.schema === "humanish.git-state.v1";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      out[key] = normalizeBundle(entry, nowInGitState);
    }
    return out;
  }
  return value;
}

const GOLDENS = [
  { id: "first-run", runId: "golden-first-run" },
  { id: "oss", runId: "golden-oss" }
] as const;

describe("lab golden equivalence (rung 2: faithfulness)", () => {
  for (const golden of GOLDENS) {
    it(`${golden.id} v2 config reproduces the pre-refactor golden bundle`, async () => {
      const resolved = await resolveLabManifest(ROOT, golden.id);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const outcome = await runLab(resolved.config, {
        cwd: ROOT,
        runId: golden.runId,
        dryRun: true
      });
      expect(outcome.result.ok ?? true).not.toBe(false);

      const producedRaw = await readFile(
        path.join(ROOT, ".humanish", "runs", golden.runId, "run.json"),
        "utf8"
      );
      const goldenRaw = await readFile(
        path.join(ROOT, "tests", "golden", "labs", `${golden.id}.json`),
        "utf8"
      );

      expect(normalizeBundle(JSON.parse(producedRaw))).toEqual(
        normalizeBundle(JSON.parse(goldenRaw))
      );
    });
  }
});
