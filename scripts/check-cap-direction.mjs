#!/usr/bin/env node
// Fails a pull request that raises or drops a cap in package.json's lint, prose:check or
// vocabulary:check script, compared with the base branch. Those checks hold each count to its cap
// from both sides; this check makes the caps move only down. A PR that has to raise one carries
// the raise-cap label and a "Cap raise:" line in its body saying why.
//
// Usage: node scripts/check-cap-direction.mjs --base <ref>
// Env: RAISE_CAP is "true" when the PR has the raise-cap label; PR_BODY is the PR's body.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CAPPED_SCRIPTS = ["lint", "prose:check", "vocabulary:check"];

/** Every `--max-<name>=<count>` flag in the capped scripts, keyed by script and flag. */
function capsOf(packageJson) {
  const scripts = JSON.parse(packageJson).scripts ?? {};
  const caps = new Map();
  for (const script of CAPPED_SCRIPTS) {
    for (const match of (scripts[script] ?? "").matchAll(/--max-([a-z-]+)=(\d+)/g)) {
      caps.set(`${script} --max-${match[1]}`, Number(match[2]));
    }
  }
  return caps;
}

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
if (!base) {
  process.stderr.write("check-cap-direction: pass --base <ref>.\n");
  process.exit(2);
}

let basePackage;
try {
  basePackage = execFileSync("git", ["show", `${base}:package.json`], { encoding: "utf8" });
} catch {
  process.stderr.write(`check-cap-direction: cannot read package.json at ${base}.\n`);
  process.exit(2);
}
const before = capsOf(basePackage);
const after = capsOf(readFileSync("package.json", "utf8"));

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
