import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-cap-direction.mjs");
const SCRIPTS = {
  lint: "node scripts/check-lint-cap.mjs --max-warnings=444",
  "prose:check": "node scripts/check-code-prose.mjs",
  "vocabulary:check": "tsx scripts/check-retired-words.ts",
  test: "vitest run --max-workers=4",
};
type Caps = {
  prose: Record<string, Record<string, number | string>>;
  vocabulary: Record<string, number>;
};
const caps = (): Caps => ({
  prose: { src: { "issue-refs": 371 }, tests: { caps: 1743 } },
  vocabulary: { lane: 188, study: 287 },
});

/** One commit's package.json scripts and scripts/caps.json; `caps: null` leaves the file out. */
type Revision = { scripts?: Record<string, string>; caps?: Caps | null };
const BASE: Revision = { scripts: SCRIPTS, caps: caps() };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "humanish-cap-direction-"));
  roots.push(root);
  const git = (...args: string[]) => {
    const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
  };
  const write = async ({ scripts = SCRIPTS, caps: capsJson = caps() }: Revision) => {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "caps-fixture", scripts }, null, 2)}\n`,
    );
    await mkdir(join(root, "scripts"), { recursive: true });
    if (capsJson === null) await rm(join(root, "scripts", "caps.json"), { force: true });
    else await writeFile(join(root, "scripts", "caps.json"), JSON.stringify(capsJson));
  };
  return { root, git, write };
}

function capDirection(root: string, baseRef: string, env: Record<string, string> = {}) {
  const { RAISE_CAP: _label, PR_BODY: _body, ...inherited } = process.env;
  const run = spawnSync(process.execPath, [script, "--base", baseRef], {
    cwd: root,
    encoding: "utf8",
    env: { ...inherited, ...env },
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** A repo whose commit `base` holds `base`, with `head` in its working tree. */
async function check(head: Revision, env: Record<string, string> = {}, base = BASE) {
  const { root, git, write } = await fixtureRoot();
  git("init", "--quiet");
  await write(base);
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  git("tag", "base");
  await write(head);
  return capDirection(root, "base", env);
}

/** caps() with one cap changed or, for `undefined`, removed. */
function capsWith(edit: (next: Caps) => void): Caps {
  const next = caps();
  edit(next);
  return next;
}

const raisedInCaps = capsWith((next) => {
  next.prose.tests!.caps = 1744;
});

describe("check-cap-direction", () => {
  it("passes when no cap changes, and when one goes down", async () => {
    expect((await check(BASE)).status).toBe(0);
    const lowered = await check({
      caps: capsWith((next) => {
        next.vocabulary.lane = 187;
      }),
    });
    expect(lowered.status).toBe(0);
    expect(lowered.output).toContain("vocabulary.lane: 188 -> 187");
  });

  it("passes a new cap and ignores flags outside lint", async () => {
    const result = await check({
      scripts: { ...SCRIPTS, test: "vitest run --max-workers=8" },
      caps: capsWith((next) => {
        next.vocabulary.seat = 6;
      }),
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("vocabulary.seat: new, 6");
  });

  it("fails a cap raised in scripts/caps.json or in lint's flags without the raise-cap label", async () => {
    const inCaps = await check({ caps: raisedInCaps });
    expect(inCaps.status).toBe(1);
    expect(inCaps.output).toContain("prose.tests.caps: 1743 -> 1744");

    const inLint = await check({
      scripts: { ...SCRIPTS, lint: "node scripts/check-lint-cap.mjs --max-warnings=445" },
    });
    expect(inLint.status).toBe(1);
    expect(inLint.output).toContain("lint --max-warnings: 444 -> 445");
  });

  it("fails a removed cap, and a removed scripts/caps.json, without the raise-cap label", async () => {
    const removed = await check({
      caps: capsWith((next) => {
        delete next.prose.src!["issue-refs"];
      }),
    });
    expect(removed.status).toBe(1);
    expect(removed.output).toContain("prose.src.issue-refs: removed (was 371)");

    const noFile = await check({ caps: null });
    expect(noFile.status).toBe(1);
    expect(noFile.output).toContain("vocabulary.study: removed (was 287)");
  });

  it("exits 2 on a cap that is not a whole number", async () => {
    const result = await check({
      caps: capsWith((next) => {
        next.prose.tests!.caps = "1743";
      }),
    });
    expect(result.status).toBe(2);
    expect(result.output).toContain("prose.tests.caps");
  });

  it("fails the label without a Cap raise: line, and passes it with one", async () => {
    const raised = { caps: raisedInCaps };
    expect((await check(raised, { RAISE_CAP: "true", PR_BODY: "Raises it." })).status).toBe(1);
    expect((await check(raised, { RAISE_CAP: "true", PR_BODY: "Cap raise:" })).status).toBe(1);
    const allowed = await check(raised, {
      RAISE_CAP: "true",
      PR_BODY: "Summary.\n\nCap raise: the new rule flags 1 existing call.\n",
    });
    expect(allowed.status).toBe(0);
  });

  it("compares a base that held its caps as package.json flags with scripts/caps.json", async () => {
    const flagBase: Revision = {
      scripts: {
        ...SCRIPTS,
        "prose:check":
          "node scripts/check-code-prose.mjs --max-issue-refs=371 --max-caps-tests=1743",
        "vocabulary:check": "tsx scripts/check-retired-words.ts --max-lane=188 --max-study=287",
      },
      caps: null,
    };
    expect((await check(BASE, {}, flagBase)).status).toBe(0);
    const raised = await check({ caps: raisedInCaps }, {}, flagBase);
    expect(raised.status).toBe(1);
    expect(raised.output).toContain("prose.tests.caps: 1743 -> 1744");
  });

  it("compares a merge commit with its first parent, not a base that moved since", async () => {
    // CI checks out the PR's merge ref, built when the PR last synced. If main lowers a cap after
    // that, the merge commit still carries main's old cap, which this PR did not raise.
    const { root, git, write } = await fixtureRoot();
    git("init", "--quiet", "--initial-branch=main");
    await write(BASE);
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "pr");
    await writeFile(join(root, "README.md"), "docs only\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "pr");
    git("checkout", "--quiet", "-b", "merge-ref", "main");
    git("merge", "--quiet", "--no-ff", "pr", "-m", "merge pr into main");
    git("checkout", "--quiet", "main");
    await write({
      caps: capsWith((next) => {
        next.prose.tests!.caps = 1742;
      }),
    });
    git("commit", "--quiet", "-am", "main lowers a cap");
    git("checkout", "--quiet", "merge-ref");
    const run = capDirection(root, "main");
    expect(run.status, run.output).toBe(0);
  });

  it("exits 2 when the base ref has no package.json", async () => {
    const { root, git } = await fixtureRoot();
    git("init", "--quiet");
    expect(capDirection(root, "missing").status).toBe(2);
  });
});
