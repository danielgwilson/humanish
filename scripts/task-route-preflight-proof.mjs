// After build: real CLI inspect/run admission, including live-mode unsupported labs.
// Configs and SDK imports are real; side-effect ports are forbidden before CLI loading.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");
const preload = join(root, "tests/fixtures/task-route-preflight/deny-side-effects.mjs");
const fixtures = JSON.parse(await readFile(join(root, "tests/fixtures/task-route-preflight/labs.json"), "utf8"));
let cases = 0;
for (const fixture of fixtures.filter(({ supported }) => !supported)) {
  const cwd = await mkdtemp(join(tmpdir(), "humanish-task-admission-"));
  try {
    const config = structuredClone(fixture.config);
    config.actors[0].tasks = [{ id: "inspect", goal: "TASK_ONLY_SENTINEL", success: { any: [{ textIncludes: "HIDDEN_SUCCESS_SENTINEL" }] } }];
    await writeFile(join(cwd, "lab.yaml"), JSON.stringify(config));
    for (const [label, command, flags] of [["inspect", "inspect", []], ["declared-mode", "run", ["--no-open"]], ["dry-run", "run", ["--dry-run", "--no-open"]]]) {
      const proofPath = join(cwd, `${label}-proof.json`);
      const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--import", preload,
        cli, "lab", command, "lab.yaml", "--cwd", cwd, "--json", ...flags], {
        cwd, encoding: "utf8", timeout: 20000,
        env: { PATH: process.env.PATH, DO_NOT_TRACK: "1", HUMANISH_STRICT_KEYS: "1",
          OPENAI_API_KEY: "synthetic-no-provider-key", E2B_API_KEY: "synthetic-no-sandbox-key",
          HUMANISH_PROOF_CLI: cli, HUMANISH_PROOF_RESULT: proofPath }
      });
      assert.equal(child.error, undefined, `${fixture.name}/${label}: ${child.error}`);
      assert.equal(child.status, 2, `${fixture.name}/${label}: ${child.stderr}`);
      const result = JSON.parse(child.stdout);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "HUMANISH_LAB_INVALID");
      assert.match(result.error.message, /actors\[0\]\.tasks is unsupported/);
      assert.doesNotMatch(child.stdout + child.stderr, /TASK_ONLY_SENTINEL|HIDDEN_SUCCESS_SENTINEL/);
      const proof = JSON.parse(await readFile(proofPath, "utf8"));
      assert.deepEqual(proof, { code: 2, attempts: [] });
      await assert.rejects(access(join(cwd, ".humanish")), { code: "ENOENT" });
      cases++;
    }
    console.log(`task preflight ${fixture.name}: inspect, ${config.scenario.mode} run and explicit dry-run refused; zero SDK/network/process attempts`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
console.log(`task preflight: ${cases}/${cases} compiled CLI admission checks passed`);
