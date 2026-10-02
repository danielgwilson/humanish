#!/usr/bin/env node
// Fails a pull request that raises or drops a cap, compared with the base branch. The caps are
// lint's --max-warnings in package.json and every prose:check and vocabulary:check cap in
// scripts/caps.json. Those checks hold each count to its cap from both sides; this check makes the
// caps move only down. A PR that has to raise one carries the raise-cap label and a "Cap raise:"
// line in its body saying why.
//
// Usage: node scripts/check-cap-direction.mjs --base <ref>
// On a merge commit (CI's PR merge ref) the base is HEAD's first parent; --base applies elsewhere.
// Env: RAISE_CAP is "true" when the PR has the raise-cap label; PR_BODY is the PR's body.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { CAPS_FILE, flattenCaps } from "./lib/caps.mjs";

// Roots other than src that prose:check flags named with a suffix before scripts/caps.json.
const PROSE_ROOTS = ["tests", "scripts", "tui"];

/** lint's `--max-<name>=<count>` flags, keyed `lint --max-<name>`. */
function lintCapsOf(packageJson) {
  const scripts = JSON.parse(packageJson).scripts ?? {};
  const caps = new Map();
  for (const match of (scripts.lint ?? "").matchAll(/--max-([a-z-]+)=(\d+)/g)) {
    caps.set(`lint --max-${match[1]}`, Number(match[2]));
  }
  return caps;
}

/**
 * The prose and vocabulary caps a revision's package.json scripts held as flags, before
 * scripts/caps.json, keyed by the path they have in that file (`prose.tests.caps`).
 */
function flagCapsOf(packageJson) {
  const scripts = JSON.parse(packageJson).scripts ?? {};
  const caps = new Map();
  for (const match of (scripts["prose:check"] ?? "").matchAll(/--max-([a-z-]+)=(\d+)/g)) {
    const root = PROSE_ROOTS.find((name) => match[1].endsWith(`-${name}`));
    const kind = root ? match[1].slice(0, -root.length - 1) : match[1];
    caps.set(`prose.${root ?? "src"}.${kind}`, Number(match[2]));
  }
  for (const match of (scripts["vocabulary:check"] ?? "").matchAll(/--max-([a-z-]+)=(\d+)/g)) {
    caps.set(`vocabulary.${match[1]}`, Number(match[2]));
  }
  return caps;
}

/**
 * Every cap in a revision: lint from package.json, the rest from scripts/caps.json, or from the
 * package.json flags of a revision before that file. Exits 2 when the file does not parse or holds
 * a cap that is not a whole number.
 */
function capsOf(revision, packageJson, capsJson) {
  const caps = lintCapsOf(packageJson);
  let rest = flagCapsOf(packageJson);
  if (capsJson !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(capsJson);
    } catch (error) {
      process.stderr.write(`check-cap-direction: ${CAPS_FILE} at ${revision}: ${error.message}\n`);
      process.exit(2);
    }
    const { flat, invalid } = flattenCaps(parsed);
    if (invalid.length > 0) {
      process.stderr.write(
        `check-cap-direction: ${CAPS_FILE} at ${revision}: not a whole number at ${invalid.join(", ")}.\n`,
      );
      process.exit(2);
    }
    rest = flat;
  }
  for (const [path, value] of rest) caps.set(path, value);
  return caps;
}

const baseIndex = process.argv.indexOf("--base");
const baseArg = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
if (!baseArg) {
  process.stderr.write("check-cap-direction: pass --base <ref>.\n");
  process.exit(2);
}
// CI checks out a PR's merge ref, built on the base as it was when the PR last synced. Its first
// parent is that base, so a cap main lowered since then does not read as this PR raising it.
// Outside a merge commit (a local branch), the given base is used.
let parents = [];
try {
  parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split(" ");
} catch {
  // No HEAD commit to inspect: use the given base, whose read below fails closed.
}
const base = parents.length > 2 ? "HEAD^1" : baseArg;

let basePackage;
try {
  basePackage = execFileSync("git", ["show", `${base}:package.json`], { encoding: "utf8" });
} catch {
  process.stderr.write(`check-cap-direction: cannot read package.json at ${base}.\n`);
  process.exit(2);
}
let baseCaps;
try {
  baseCaps = execFileSync("git", ["show", `${base}:${CAPS_FILE}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  // A base from before scripts/caps.json: its caps are flags in package.json.
}
const before = capsOf(base, basePackage, baseCaps);
const after = capsOf(
  "the working tree",
  readFileSync("package.json", "utf8"),
  existsSync(CAPS_FILE) ? readFileSync(CAPS_FILE, "utf8") : undefined,
);

const changes = [];
for (const [cap, was] of before) {
  const now = after.get(cap);
  if (now === undefined) changes.push(`${cap}: removed (was ${was})`);
  else if (now > was) changes.push(`${cap}: ${was} -> ${now}`);
}
for (const [cap, now] of after) {
  const was = before.get(cap);
  if (was !== undefined && now < was) process.stdout.write(`${cap}: ${was} -> ${now}\n`);
  if (was === undefined) process.stdout.write(`${cap}: new, ${now}\n`);
}

if (changes.length === 0) {
  process.stdout.write(`No cap went up against ${base}.\n`);
  process.exit(0);
}
process.stdout.write(changes.map((change) => `${change}\n`).join(""));
if (process.env.RAISE_CAP !== "true") {
  process.stdout.write(
    "A cap went up or was removed. Lower the count instead, or add the raise-cap label and a\n" +
      '"Cap raise:" line in the PR body that says why.\n',
  );
  process.exit(1);
}
if (!/^Cap raise:[ \t]*\S/m.test(process.env.PR_BODY ?? "")) {
  process.stdout.write(
    'The raise-cap label needs a "Cap raise:" line in the PR body that says why.\n',
  );
  process.exit(1);
}
process.stdout.write("Allowed by the raise-cap label and the PR body's Cap raise: line.\n");
