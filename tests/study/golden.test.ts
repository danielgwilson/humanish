import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runStudyWith } from "../../src/run-study.js";
import { parse } from "yaml";

import { parseStudyDocument } from "../../src/study/config.js";

// Rung 2 (faithfulness): the v2 config + one-engine path must reproduce the pre-refactor run
// bundles captured by scripts/capture-lab-goldens.mjs. We pin the same run-id as the golden so
// only timestamps vary; normalizeTimestamps removes those. The bundle already redacts cwd to a
// stable placeholder, so the comparison is environment-independent.
//
// first-run (synthetic) is deterministic in dry-run.
//
// The run is written into a temporary git project holding a copy of the repo's study source, so
// the fixed run id never collides with an earlier run and the repo's own .humanish is untouched.

const ROOT = process.cwd();
const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)(
    "git",
    ["-c", "user.name=golden", "-c", "user.email=golden@example.test", ...args],
    { cwd },
  );

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "humanish-lab-golden-"));
  await cp(path.join(ROOT, "humanish"), path.join(project, "humanish"), { recursive: true });
  // The golden is a v2 run: the pre-refactor first-run file at its pre-0.108 path, with its v3
  // twin removed. Discovery refuses a v2 file, so the test parses it the way migrate does and
  // gives the engine the provenance the CLI records for a committed study file.
  await rm(path.join(project, "humanish", "studies", "first-run.yaml"));
  await mkdir(path.join(project, "humanish", "labs"), { recursive: true });
  await cp(
    path.join(ROOT, "tests", "fixtures", "labs-v2", "first-run.yaml"),
    path.join(project, "humanish", "labs", "first-run.yaml"),
  );
  await cp(path.join(ROOT, "package.json"), path.join(project, "package.json"));
  // The golden records a clean, attached work tree; its values are masked, its shape is not.
  await git(project, "init", "--quiet");
  await git(project, "add", "--all");
  await git(project, "commit", "--quiet", "--message", "golden source");
});

afterEach(async () => {
  await rm(project, { force: true, recursive: true });
});

// Normalize the two ambient, non-behavioral parts of a run bundle: ISO timestamps and the
// captured git working-tree state. The git-state subtree (status/sha/refState/change-counts) is
// 100% environment-dependent: it differs between a local worktree (attached HEAD) and a CI PR
// checkout (detached HEAD), and is not part of what this refactor must preserve. We mask every
// leaf value inside it while keeping its structure (keys) asserted, so a structural regression in
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

const GOLDENS = [{ id: "first-run", runId: "golden-first-run" }] as const;

describe("lab golden equivalence (rung 2: faithfulness)", () => {
  for (const golden of GOLDENS) {
    it(`${golden.id} v2 config reproduces the pre-refactor golden bundle`, async () => {
      const file = path.join("humanish", "labs", `${golden.id}.yaml`);
      const resolved = parseStudyDocument(parse(await readFile(path.join(project, file), "utf8")));
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const outcome = await runStudyWith(resolved.config, {
        cwd: project,
        runId: golden.runId,
        dryRun: true,
        // The golden is captured through the real CLI, which resolves the manifest and stamps the
        // run's study provenance. Faithfulness means invoking the same way, so this test
        // supplies exactly what the resolution step supplies.
        study: { id: resolved.config.id, path: file, origin: "committed" },
      });
      expect(outcome.result.ok ?? true).not.toBe(false);

      const producedRaw = await readFile(
        path.join(project, ".humanish", "runs", golden.runId, "run.json"),
        "utf8",
      );
      const goldenRaw = await readFile(
        path.join(ROOT, "tests", "golden", "labs", `${golden.id}.json`),
        "utf8",
      );

      expect(normalizeBundle(JSON.parse(producedRaw))).toEqual(
        normalizeBundle(JSON.parse(goldenRaw)),
      );
    });
  }
});
