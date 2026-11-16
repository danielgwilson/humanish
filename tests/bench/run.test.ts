import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// A stand-in humanish CLI: `--version`, and a `run --dry-run` that writes a bundle whose one
// participant records the mission given for that study's build letter, then answers ok.
const FAKE_CLI = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.0.0"); process.exit(0); }
const missions = JSON.parse(process.env.FAKE_MISSIONS);
const study = args[1];
const cwd = args[args.indexOf("--cwd") + 1];
const runId = "dry-" + study;
const runDir = path.join(cwd, ".humanish", "runs", runId);
mkdirSync(runDir, { recursive: true });
const mission = study.startsWith("bench-taskly-a-") ? missions.a : missions.b;
writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, streams: [{ id: "stream-001", assignment: { mission } }] }));
console.log(JSON.stringify({ ok: true, runId, plan: { worstCaseSandboxMinutes: 11 } }));
`;

function dryRun(missions: { a: string; b: string }): { status: number | null; stdout: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-run-"));
  try {
    const cli = path.join(dir, "fake-cli.mjs");
    writeFileSync(cli, FAKE_CLI);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "bench/run.ts",
        "--dry-run",
        "--mission",
        "default",
        "--cli",
        cli,
        "--work-dir",
        path.join(dir, "work"),
      ],
      { encoding: "utf8", env: { ...process.env, FAKE_MISSIONS: JSON.stringify(missions) } },
    );
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("plans with the digest of the one mission the CLI's dry runs recorded", () => {
  const { status, stdout } = dryRun({ a: "abc", b: "abc" });
  expect(status).toBe(0);
  expect(stdout.split("\n")[0]).toMatch(/\(sha256 ba7816bf8f01\)/);
});

it("refuses before planning when the dry runs of the two builds record different missions", () => {
  const { status, stdout } = dryRun({ a: "abc", b: "abd" });
  expect(status).toBe(2);
  expect(stdout).toBe("");
});
