// After build: `--dotenv` and its `--env-file` alias, run through Node as a user runs them.
// Node scans the whole argv for `--env-file` before dist/cli.js loads, so the alias with a missing
// file exits 9 from Node, and `--dotenv` with a missing file reaches humanish's exit-2 envelope.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");
const renamed =
  "`--env-file` is now `--dotenv`; `--env-file` is removed in the first minor release on or after 2026-11-03.";
const cwd = await mkdtemp(join(tmpdir(), "humanish-dotenv-proof-"));

function humanish(...args) {
  const child = spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 20000,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      XDG_CONFIG_HOME: join(cwd, "config"),
      DO_NOT_TRACK: "1",
      HUMANISH_STRICT_KEYS: "1",
    },
  });
  assert.equal(child.error, undefined, `${args.join(" ")}: ${child.error}`);
  return child;
}

function e2bRow(stdout) {
  const result = JSON.parse(stdout);
  return { result, row: result.checks.find((check) => check.name === "key E2B_API_KEY") };
}

try {
  await writeFile(join(cwd, "present.env"), "E2B_API_KEY=synthetic-dotenv-proof-key\n");

  const missing = humanish("reclaim", "--run", "proof-run", "--dotenv", "missing.env");
  assert.equal(missing.status, 2, missing.stderr);
  const envelope = JSON.parse(missing.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "HUMANISH_ENV_FILE_NOT_FOUND");

  const intercepted = humanish("reclaim", "--run", "proof-run", "--env-file", "missing.env");
  assert.equal(intercepted.status, 9, intercepted.stderr);
  assert.equal(intercepted.stdout, "");
  assert.match(intercepted.stderr, /: missing\.env: not found\n$/);

  const labelled = humanish("doctor", "--dotenv", "present.env");
  const { row } = e2bRow(labelled.stdout);
  assert.match(row.message, /^supplied by --dotenv present\.env;/);

  const alias = humanish("doctor", "--env-file", "present.env");
  const aliased = e2bRow(alias.stdout);
  assert.match(aliased.row.message, /^supplied by --dotenv present\.env;/);
  assert.deepEqual(aliased.result.warnings, [renamed]);
  assert.equal(alias.stderr, `warning: ${renamed}\n`);

  for (const child of [missing, intercepted, labelled, alias]) {
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-dotenv-proof-key/);
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
process.stdout.write("dotenv proof passed: 4 cases\n");
