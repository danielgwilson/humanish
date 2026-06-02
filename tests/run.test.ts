import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import {
  RUN_BUNDLE_SCHEMA,
  listRuns,
  readReview,
  runDryRun,
  verifyRun
} from "../src/run.js";

async function withFixtureCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-run-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  await program.parseAsync(["node", "mimetic", ...args], { from: "node" });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join("")
  };
}

describe("dry-run bundles", () => {
  it("writes and verifies a synthetic run bundle", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "dryrun-test"
      });

      expect(run.ok).toBe(true);
      expect(run.runId).toBe("dryrun-test");
      expect(run.bundlePath).toBe(".mimetic/runs/dryrun-test/run.json");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/dryrun-test/run.json"), "utf8")
      ) as { schema: string; review: { verdict: string }; simCount: number; simulations: unknown[] };
      expect(bundle.schema).toBe(RUN_BUNDLE_SCHEMA);
      expect(bundle.simCount).toBe(1);
      expect(bundle.simulations).toHaveLength(1);
      expect(bundle.review.verdict).toBe("contract_proof_only");

      await expect(stat(path.join(cwd, ".mimetic/runs/latest.json"))).resolves.toBeTruthy();

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
      expect(verify.checks.every((check) => check.ok)).toBe(true);

      const review = await readReview(cwd, "latest");
      expect("verdict" in review ? review.verdict : null).toBe("contract_proof_only");

      const runs = await listRuns(cwd);
      expect(runs.latest).toBe("dryrun-test");
      expect(runs.runs).toHaveLength(1);
    });
  });

  it("keeps live runs fail-closed", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({ cwd });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LIVE_RUN_UNIMPLEMENTED");
      await expect(stat(path.join(cwd, ".mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("runs one explicit local Codex TUI actor with sanitized lifecycle evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('codex fixture actor started\\n');",
          "process.stdout.write('secret-like value ' + 'sk-' + 'testsecretvalue1234567890' + '\\n');",
          "process.stdout.write('MIMETIC_ACTOR_VERDICT=passed\\n');"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-tui-test",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.runId).toBe("codex-tui-test");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-tui-test/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        mode: string;
        review: { verdict: string };
        simulations: Array<{ status: string; streamKind: string }>;
        streams: Array<{
          completion: { status: string };
          kind: string;
          terminal: { tail: string };
          transport: string;
        }>;
      };

      expect(bundle.mode).toBe("live");
      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.simulations).toEqual([expect.objectContaining({ status: "passed", streamKind: "tui" })]);
      expect(bundle.streams).toEqual([
        expect.objectContaining({
          completion: expect.objectContaining({ status: "passed" }),
          kind: "tui",
          transport: "pty"
        })
      ]);
      expect(bundle.streams[0]?.terminal.tail).toContain("codex fixture actor started");
      expect(bundle.streams[0]?.terminal.tail).toContain("[REDACTED_SECRET]");
      expect(bundle.streams[0]?.terminal.tail).not.toContain(`sk-${"testsecretvalue"}`);
      expect(bundle.events.map((event) => event.type)).toContain("actor.spawned");
      expect(bundle.events.map((event) => event.type)).toContain("actor.prompt.submitted");
      expect(bundle.events.map((event) => event.type)).toContain("actor.verdict");
      expect(bundle.events.some((event) => event.message.includes(`sk-${"testsecretvalue"}`))).toBe(false);

      const transcript = await readFile(
        path.join(cwd, ".mimetic/runs/codex-tui-test/transcripts/codex-tui-sanitized.txt"),
        "utf8"
      );
      expect(transcript).toContain("[REDACTED_SECRET]");
      expect(transcript).not.toContain(`sk-${"testsecretvalue"}`);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("exposes explicit local Codex TUI actor runs through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-cli.mjs");
      const previousCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      await writeFile(
        fakeActor,
        "process.stdout.write('cli fixture actor passed\\n');\n",
        "utf8"
      );
      process.env.MIMETIC_CODEX_ACTOR_COMMAND = `${process.execPath} ${fakeActor}`;

      try {
        const result = await runCli([
          "run",
          "--actor",
          "codex-tui",
          "--sims",
          "1",
          "--timeout-ms",
          "5000",
          "--run-id",
          "codex-cli",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout) as { mode: string; ok: boolean; runId: string };
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("live");
        expect(envelope.runId).toBe("codex-cli");

        const watch = await runCli([
          "watch",
          "--run",
          "codex-cli",
          "--detach",
          "--no-open",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(watch.exitCode).toBe(0);
        const observer = JSON.parse(watch.stdout) as { ok: boolean; observerPath: string };
        expect(observer.ok).toBe(true);
        expect(observer.observerPath).toBe(".mimetic/runs/codex-cli/observer/index.html");
      } finally {
        if (previousCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousCommand;
        }
      }
    });
  });

  it("blocks the default Codex TUI actor before spawn when workspace trust is missing", async () => {
    await withFixtureCopy(async (cwd) => {
      const codexHome = path.join(cwd, ".codex-home");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousActorCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
      await mkdir(codexHome, { recursive: true });
      delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      process.env.CODEX_HOME = codexHome;

      try {
        const result = await runDryRun({
          cwd,
          actor: "codex-tui",
          runId: "codex-trust-blocked",
          simCount: 1,
          timeoutMs: 5_000
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

        const bundle = JSON.parse(
          await readFile(path.join(cwd, ".mimetic/runs/codex-trust-blocked/run.json"), "utf8")
        ) as {
          events: Array<{ type: string }>;
          review: { verdict: string };
          streams: Array<{ status: string; terminal: { tail: string } }>;
        };
        expect(bundle.review.verdict).toBe("blocked");
        expect(bundle.streams[0]?.status).toBe("blocked");
        expect(bundle.streams[0]?.terminal.tail).toContain("Codex workspace trust preflight blocked");
        expect(bundle.events.map((event) => event.type)).toContain("actor.preflight.blocked");
        expect(bundle.events.map((event) => event.type)).toContain("actor.blocked");
        expect(bundle.events.map((event) => event.type)).not.toContain("actor.spawned");

        const verify = await verifyRun(cwd, "latest");
        expect(verify.ok).toBe(true);
      } finally {
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        if (previousActorCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousActorCommand;
        }
      }
    });
  });

  it("exposes run and verify through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runCli([
        "run",
        "--dry-run",
        "--run-id",
        "dryrun-cli",
        "--cwd",
        cwd,
        "--json"
      ]);
      expect(run.exitCode).toBe(0);
      const runResult = JSON.parse(run.stdout) as { ok: boolean; runId: string };
      expect(runResult.ok).toBe(true);
      expect(runResult.runId).toBe("dryrun-cli");

      const verify = await runCli(["verify", "--run", "latest", "--cwd", cwd, "--json"]);
      expect(verify.exitCode).toBe(0);
      const verifyResult = JSON.parse(verify.stdout) as { ok: boolean };
      expect(verifyResult.ok).toBe(true);
    });
  });
});
