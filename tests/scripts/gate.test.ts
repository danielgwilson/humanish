import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type GateStage, planGate, runGate } from "../../scripts/lib/gate.mjs";

const stageNames = (changedPaths: readonly string[] | undefined) =>
  planGate(changedPaths, {}).stages.map((stage) => stage.name);

describe("planGate", () => {
  it("adds the site job's typecheck, registry check and build for a change under site/", () => {
    expect(planGate(["site/content/docs/cli.mdx"], {}).stages).toEqual([
      { name: "release:check", command: ["pnpm", "release:check"] },
      { name: "site typecheck", command: ["pnpm", "--filter", "humanish-site", "typecheck"] },
      {
        name: "site registry:check",
        command: ["pnpm", "--filter", "humanish-site", "registry:check"],
      },
      { name: "site build", command: ["pnpm", "--filter", "humanish-site", "build"] },
    ]);
  });

  it("adds the observer workspace tests for a change to code the observer tests import", () => {
    for (const path of [
      "observer/app.tsx",
      "src/run/run-clock.ts",
      "tests/golden/observer-data/live.json",
      "scripts/observer-browser-fixtures.mjs",
    ]) {
      expect(planGate([path], {}).stages.slice(1)).toEqual([
        { name: "observer test", command: ["pnpm", "--filter", "humanish-observer", "test"] },
      ]);
    }
  });

  it("runs release:check alone for a change under docs/ or to a root guide", () => {
    expect(stageNames(["docs/ramp/README.md", "CONTRIBUTING.md", "tui/src/app.tsx"])).toEqual([
      "release:check",
    ]);
  });

  it("runs every stage for a manifest change and when no merge-base was found", () => {
    const every = [
      "release:check",
      "site typecheck",
      "site registry:check",
      "site build",
      "observer test",
    ];
    expect(stageNames(["pnpm-lock.yaml"])).toEqual(every);
    expect(stageNames(undefined)).toEqual(every);
  });

  it("defers the browser proofs, Docker and PR-only jobs, the other Node version and skipped stages", () => {
    const deferred = planGate(["docs/ramp/README.md"], {}).deferred.map((check) => check.name);
    expect(deferred).toEqual([
      "site typecheck",
      "site registry:check",
      "site build",
      "observer test",
      "site:hero:proof",
      "browser-control:proof",
      "observer:iframe:proof",
      "observer:browser:proof",
      "observer:chrome:proof",
      "observer:reliability:proof",
      "secret-scan",
      "cap-direction",
      "guest-desktop",
      "node-floor",
      "public-surface denylist",
    ]);
    const withDenylist = planGate(undefined, { HUMANISH_PUBLIC_DENYLIST_PATTERN: "private-name" });
    expect(withDenylist.deferred.map((check) => check.name)).toEqual(deferred.slice(4, -1));
  });

  it("gives each deferred check a reason", () => {
    const { deferred } = planGate([], {});
    expect(deferred.filter((check) => check.reason.trim() === "")).toEqual([]);
    expect(deferred.find((check) => check.name === "site build")?.reason).toBe(
      "no changed path under site/ or in the package manifests",
    );
  });
});

const hooks = resolve(".githooks");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", ["-c", "user.name=gate", "-c", "user.email=gate", ...args], {
    cwd,
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

/** A repo with one commit and a bare `origin`, and a push that runs .githooks/pre-push. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "humanish-gate-"));
  roots.push(root);
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "remote.git");
  git(root, "init", "--quiet", "work");
  await writeFile(join(work, ".gitignore"), ".humanish/\n");
  await writeFile(join(work, "app.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "first");
  git(work, "remote", "add", "origin", join(root, "remote.git"));
  const push = (...args: string[]) => {
    const run = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "push", ...args], {
      cwd: work,
      encoding: "utf8",
    });
    return { status: run.status, stderr: run.stderr };
  };
  return { work, push };
}

const node = (source: string) => [process.execPath, "-e", source];
// Exits 0 only under CI=true, which every stage runs with.
const passesUnderCi = node("process.exit(process.env.CI === 'true' ? 0 : 5)");

async function gate(cwd: string, stages: GateStage[]) {
  let output = "";
  const write = (text: string) => {
    output += text;
  };
  const code = await runGate({ cwd, plan: { stages, deferred: DEFERRED }, write });
  return { code, output };
}
const DEFERRED = [{ name: "secret-scan", reason: "CI runs gitleaks in Docker" }];

describe("runGate and the pre-push hook", () => {
  it("records a pass by tree, so a message-only amend still pushes and a content change does not", async () => {
    const { work, push } = await repo();
    const result = await gate(work, [{ name: "check", command: passesUnderCi }]);
    expect(result.code, result.output).toBe(0);

    git(work, "commit", "--quiet", "--amend", "-m", "first, reworded");
    expect(push("origin", "HEAD:refs/heads/topic").status).toBe(0);

    await writeFile(join(work, "app.txt"), "two\n");
    git(work, "commit", "--quiet", "-am", "second");
    const refused = push("origin", "HEAD:refs/heads/topic");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("pnpm gate");
  });

  it("writes a marker that records the stages run, the checks deferred and the Node version", async () => {
    const { work } = await repo();
    expect((await gate(work, [{ name: "check", command: passesUnderCi }])).code).toBe(0);
    const tree = git(work, "rev-parse", "HEAD^{tree}");
    const marker = JSON.parse(await readFile(join(work, ".git", "humanish-gate", tree), "utf8"));
    expect(marker).toMatchObject({ tree, deferred: DEFERRED, node: process.version });
    expect(marker.stages.map((stage: { name: string }) => stage.name)).toEqual(["check"]);
  });

  it("refuses a worktree with uncommitted or untracked files before any stage runs", async () => {
    const { work } = await repo();
    const ran = join(work, ".humanish", "ran");
    const marksRan = node(
      `require("fs").mkdirSync(".humanish", { recursive: true }); require("fs").writeFileSync(${JSON.stringify(ran)}, "")`,
    );
    await writeFile(join(work, "notes.txt"), "draft\n");
    await writeFile(join(work, "app.txt"), "edited\n");
    const refused = await gate(work, [{ name: "check", command: marksRan }]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(" M app.txt");
    expect(refused.output).toContain("?? notes.txt");
    expect(existsSync(ran)).toBe(false);

    await rm(join(work, "notes.txt"));
    git(work, "checkout", "--", "app.txt");
    await mkdir(join(work, ".humanish"), { recursive: true });
    await writeFile(join(work, ".humanish", "ignored.txt"), "gitignored\n");
    expect((await gate(work, [{ name: "check", command: marksRan }])).code).toBe(0);
    expect(existsSync(ran)).toBe(true);
  });

  it("stops at a failing stage with its exit code, log tail and log path, and records no pass", async () => {
    const { work, push } = await repo();
    const failing = node(
      "console.log('compiling'); console.error('error TS2322 in app.ts'); process.exit(3)",
    );
    const later = join(work, ".humanish", "later");
    const result = await gate(work, [
      { name: "type check", command: failing },
      { name: "later", command: node(`require("fs").writeFileSync(${JSON.stringify(later)}, "")`) },
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("type check  failed with exit code 3");
    expect(result.output).toContain("error TS2322 in app.ts");
    expect(result.output).toContain("Full log: .humanish/gate/type-check.log");
    expect(await readFile(join(work, ".humanish", "gate", "type-check.log"), "utf8")).toBe(
      "compiling\nerror TS2322 in app.ts\n",
    );
    expect(existsSync(later)).toBe(false);
    expect(push("origin", "HEAD:refs/heads/topic").status).toBe(1);
  });

  it("records no pass when a stage leaves a file git would commit", async () => {
    const { work, push } = await repo();
    const strays = node('require("fs").writeFileSync("generated.txt", "")');
    const result = await gate(work, [{ name: "build", command: strays }]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("?? generated.txt");
    expect(push("origin", "HEAD:refs/heads/topic").status).toBe(1);
  });
});

describe("the pre-push hook", () => {
  it("refuses a branch with no gate pass and lets deletions and tags through", async () => {
    const { work, push } = await repo();
    const refused = push("origin", "HEAD:refs/heads/topic");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("pnpm gate");

    git(work, "tag", "v1");
    expect(push("origin", "refs/tags/v1").status).toBe(0);
    expect(push("--no-verify", "origin", "HEAD:refs/heads/old").status).toBe(0);
    expect(push("origin", ":refs/heads/old").status).toBe(0);
  });

  it("refuses the whole push when one of its branches has no gate pass", async () => {
    const { work, push } = await repo();
    expect((await gate(work, [{ name: "check", command: passesUnderCi }])).code).toBe(0);
    const passed = git(work, "rev-parse", "HEAD");
    await writeFile(join(work, "app.txt"), "two\n");
    git(work, "commit", "--quiet", "-am", "second");
    const result = push("origin", `${passed}:refs/heads/passed`, "HEAD:refs/heads/unchecked");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refs/heads/unchecked");
    expect(result.stderr).not.toContain("refs/heads/passed");
  });
});
