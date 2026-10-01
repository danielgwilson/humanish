import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-cap-direction.mjs");
const BASE_SCRIPTS = {
  lint: "node scripts/check-lint-cap.mjs --max-warnings=444",
  "prose:check": "node scripts/check-code-prose.mjs --max-issue-refs=371 --max-caps=1743",
  "vocabulary:check": "tsx scripts/check-retired-words.ts --max-lane=188 --max-study=287",
  test: "vitest run --max-workers=4",
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const packageJson = (scripts: Record<string, string>) =>
  `${JSON.stringify({ name: "caps-fixture", scripts }, null, 2)}\n`;

/** A repo whose commit `base` has BASE_SCRIPTS, with `scripts` in its working package.json. */
async function check(scripts: Record<string, string>, env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "humanish-cap-direction-"));
  roots.push(root);
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  };
  git("init", "--quiet");
  await writeFile(join(root, "package.json"), packageJson(BASE_SCRIPTS));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base");
  git("tag", "base");
  await writeFile(join(root, "package.json"), packageJson(scripts));
  const { RAISE_CAP: _label, PR_BODY: _body, ...inherited } = process.env;
  const run = spawnSync(process.execPath, [script, "--base", "base"], {
    cwd: root,
    encoding: "utf8",
    env: { ...inherited, ...env },
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const raised = { ...BASE_SCRIPTS, lint: "node scripts/check-lint-cap.mjs --max-warnings=445" };

describe("check-cap-direction", () => {
  it("passes when no cap changes, and when one goes down", async () => {
    expect((await check(BASE_SCRIPTS)).status).toBe(0);
    const lowered = await check({
      ...BASE_SCRIPTS,
      "vocabulary:check": "tsx scripts/check-retired-words.ts --max-lane=187 --max-study=287",
    });
    expect(lowered.status).toBe(0);
    expect(lowered.output).toContain("vocabulary:check --max-lane: 188 -> 187");
  });

  it("passes a new cap and ignores flags outside the capped scripts", async () => {
    const result = await check({
      ...BASE_SCRIPTS,
      "vocabulary:check":
        "tsx scripts/check-retired-words.ts --max-lane=188 --max-study=287 --max-seat=6",
      test: "vitest run --max-workers=8",
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("vocabulary:check --max-seat: new, 6");
  });

  it("fails a raised cap without the raise-cap label", async () => {
    const result = await check(raised);
    expect(result.status).toBe(1);
    expect(result.output).toContain("lint --max-warnings: 444 -> 445");
  });

  it("fails a removed cap without the raise-cap label", async () => {
    const result = await check({
      ...BASE_SCRIPTS,
      "prose:check": "node scripts/check-code-prose.mjs --max-caps=1743",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("prose:check --max-issue-refs: removed (was 371)");
  });

  it("fails the label without a Cap raise: line, and passes it with one", async () => {
    expect((await check(raised, { RAISE_CAP: "true", PR_BODY: "Raises it." })).status).toBe(1);
    expect((await check(raised, { RAISE_CAP: "true", PR_BODY: "Cap raise:" })).status).toBe(1);
    const allowed = await check(raised, {
      RAISE_CAP: "true",
      PR_BODY: "Summary.\n\nCap raise: the new rule flags 1 existing call.\n",
    });
    expect(allowed.status).toBe(0);
  });

  it("compares a merge commit with its first parent, not a base that moved since", async () => {
    // CI checks out the PR's merge ref, built when the PR last synced. If main lowers a cap after
    // that, the merge commit still carries main's old cap, which this PR did not raise.
    const root = await mkdtemp(join(tmpdir(), "humanish-cap-direction-"));
    roots.push(root);
    const git = (...args: string[]) => {
      const run = spawnSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { cwd: root, encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
    };
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(root, "package.json"), packageJson(BASE_SCRIPTS));
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "pr");
    await writeFile(join(root, "README.md"), "docs only\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "pr");
    git("checkout", "--quiet", "-b", "merge-ref", "main");
    git("merge", "--quiet", "--no-ff", "pr", "-m", "merge pr into main");
    git("checkout", "--quiet", "main");
    await writeFile(
      join(root, "package.json"),
      packageJson({
        ...BASE_SCRIPTS,
        "prose:check": "node scripts/check-code-prose.mjs --max-issue-refs=371 --max-caps=1742",
      }),
    );
    git("commit", "--quiet", "-am", "main lowers a cap");
    git("checkout", "--quiet", "merge-ref");
    const { RAISE_CAP: _label, PR_BODY: _body, ...inherited } = process.env;
    const run = spawnSync(process.execPath, [script, "--base", "main"], {
      cwd: root,
      encoding: "utf8",
      env: inherited,
    });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it("exits 2 when the base ref has no package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "humanish-cap-direction-"));
    roots.push(root);
    spawnSync("git", ["init", "--quiet"], { cwd: root });
    const run = spawnSync(process.execPath, [script, "--base", "missing"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
  });
});
