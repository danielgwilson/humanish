// The local gate behind `pnpm gate`: the CI-required checks that run locally, then a marker keyed
// by the tree it tested, which .githooks/pre-push looks for. A marker is keyed by tree, so amending
// only the message keeps it valid and any content change needs a new run.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

// Changes to these reach every workspace through dependencies, overrides and the catalog.
const MANIFESTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

const site = (script) => ["pnpm", "--filter", "humanish-site", script];

// Steps of CI-required jobs that release:check does not run, with the paths whose change can
// affect them. The site reads nothing outside site/. Observer tests import src/, tests/golden/,
// tests/helpers/ and scripts/observer-browser-fixtures.mjs. The tui job's typecheck and tests
// already run inside release:check, and so do the observer typecheck, build and docs:check.
const EXTRA_STAGES = [
  { name: "site typecheck", command: site("typecheck"), inputs: ["site/"] },
  { name: "site registry:check", command: site("registry:check"), inputs: ["site/"] },
  { name: "site build", command: site("build"), inputs: ["site/"] },
  {
    name: "observer test",
    command: ["pnpm", "--filter", "humanish-observer", "test"],
    inputs: ["observer/", "src/", "tests/", "scripts/"],
  },
];

// Required CI steps the gate leaves to CI: browser proofs take minutes each, secret-scan and
// guest-desktop need Docker, and cap-direction reads the PR's label and body.
const CI_ONLY = [
  { name: "site:hero:proof", reason: "CI's site job runs it in Chromium" },
  { name: "browser-control:proof", reason: "CI's observer job runs it in Chrome" },
  ...["iframe", "browser", "chrome", "reliability"].map((proof) => ({
    name: `observer:${proof}:proof`,
    reason: "CI's observer job runs it in Chromium",
  })),
  { name: "secret-scan", reason: "CI runs gitleaks in Docker over the full history" },
  { name: "cap-direction", reason: "CI reads the PR's raise-cap label and body" },
  { name: "guest-desktop", reason: "CI builds the guest image when guest files change" },
  { name: "node-floor", reason: "CI also runs release:check on Node 22.19.0" },
];

/** True when a changed path is under one of `inputs` (a trailing slash) or is a manifest. */
function touches(changedPaths, inputs) {
  return changedPaths.some(
    (path) => MANIFESTS.includes(path) || inputs.some((input) => path.startsWith(input)),
  );
}

/**
 * The stages to run for the paths changed since the merge-base with origin/main, and the checks
 * left to CI with the reason for each. `undefined` paths (no base found) runs every stage.
 */
export function planGate(changedPaths, env) {
  const stages = [{ name: "release:check", command: ["pnpm", "release:check"] }];
  const deferred = [];
  for (const { name, command, inputs } of EXTRA_STAGES) {
    if (changedPaths === undefined || touches(changedPaths, inputs)) {
      stages.push({ name, command });
    } else {
      const under = inputs.join(", ");
      deferred.push({ name, reason: `no changed path under ${under} or in the package manifests` });
    }
  }
  deferred.push(...CI_ONLY);
  if (!env.HUMANISH_PUBLIC_DENYLIST_PATTERN) {
    deferred.push({
      name: "public-surface denylist",
      reason: "CI gives public-surface:scan HUMANISH_PUBLIC_DENYLIST_PATTERN, which is unset here",
    });
  }
  return { stages, deferred };
}

const TAIL_LINES = 40;

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

/** Tracked changes and untracked files, one porcelain line each; ignored files do not count. */
const uncommitted = (cwd) => git(cwd, "status", "--porcelain").split("\n").filter(Boolean);
const headTree = (cwd) => git(cwd, "rev-parse", "HEAD^{tree}").trim();

/** Runs one command with CI=true, its output to `logFile`; resolves with how it ended. */
function runStage(command, cwd, logFile) {
  const fd = openSync(logFile, "w");
  return new Promise((done) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      closeSync(fd);
      done(outcome);
    };
    const [file, ...args] = command;
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (error) => {
      writeSync(fd, `${error.message}\n`);
      finish({ code: null, signal: null });
    });
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

function lastLines(file, count) {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  return lines.slice(-count).join("\n");
}

/**
 * Runs `plan.stages` in order on a clean worktree and, when every stage passes and the worktree is
 * still clean on the same tree, writes the marker the pre-push hook looks for:
 * `<git common dir>/humanish-gate/<tree sha of HEAD>`. Stops at the first failing stage. Returns
 * the exit code for the process.
 */
export async function runGate({ cwd, plan, write }) {
  const dirty = uncommitted(cwd);
  if (dirty.length > 0) {
    write(
      `gate: the worktree has uncommitted changes, so HEAD's tree is not what the checks would test:\n` +
        `${dirty.map((line) => `  ${line}`).join("\n")}\n` +
        "Commit or stash them, then run pnpm gate again.\n",
    );
    return 1;
  }
  const tree = headTree(cwd);
  const commit = git(cwd, "rev-parse", "HEAD").trim();
  write(`gate: testing tree ${tree.slice(0, 12)} (commit ${commit.slice(0, 12)})\n`);

  mkdirSync(join(cwd, ".humanish", "gate"), { recursive: true });
  const width = Math.max(...plan.stages.map((stage) => stage.name.length));
  const passed = [];
  for (const stage of plan.stages) {
    const log = join(".humanish", "gate", `${stage.name.replace(/[^\w.-]+/g, "-")}.log`);
    write(`${stage.name.padEnd(width)}  `);
    const started = performance.now();
    const { code, signal } = await runStage(stage.command, cwd, join(cwd, log));
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    if (code === 0) {
      write(`passed in ${seconds} s\n`);
      passed.push({ name: stage.name, seconds });
      continue;
    }
    const ending = signal
      ? `signal ${signal}`
      : code === null
        ? "no exit code"
        : `exit code ${code}`;
    write(`failed with ${ending} after ${seconds} s\n`);
    write(
      `--- last ${TAIL_LINES} lines of ${log} ---\n${lastLines(join(cwd, log), TAIL_LINES)}\n---\n`,
    );
    write(`gate: ${stage.name} failed, so no pass is recorded. Full log: ${log}\n`);
    return 1;
  }

  const left = uncommitted(cwd);
  if (left.length > 0 || headTree(cwd) !== tree) {
    write(
      "gate: the worktree changed while the checks ran, so no pass is recorded:\n" +
        `${left.map((line) => `  ${line}`).join("\n") || "  HEAD now points at a different tree"}\n` +
        "A check that writes files outside gitignored paths needs fixing, or commit the change and run pnpm gate again.\n",
    );
    return 1;
  }
  const markers = join(
    resolve(cwd, git(cwd, "rev-parse", "--git-common-dir").trim()),
    "humanish-gate",
  );
  mkdirSync(markers, { recursive: true });
  const marker = join(markers, tree);
  const record = {
    tree,
    commit,
    stages: passed,
    deferred: plan.deferred,
    node: process.version,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`);
  write(`deferred to CI: ${plan.deferred.map((check) => check.name).join(", ")}\n`);
  write(`gate: passed. Recorded ${marker}\n`);
  return 0;
}
