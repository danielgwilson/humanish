import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${filePath}`);
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
          "process.stdout.write('\\u001b[6n');",
          "process.stdin.setEncoding('latin1');",
          "const timeout = setTimeout(() => { process.stdout.write('terminal response missing\\n'); process.exit(1); }, 1000);",
          "process.stdin.on('data', (data) => {",
          "  if (!data.includes('\\u001b[24;120R')) return;",
          "  clearTimeout(timeout);",
          "  process.stdout.write('secret-like value ' + 'sk-' + 'testsecretvalue1234567890' + '\\n');",
          "  process.stdout.write(('MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE).split('').join('\\u001b7\\u001b8') + '\\n');",
          "  process.exit(0);",
          "});"
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
        simulations: Array<{ mode: string; status: string; streamKind: string }>;
        streams: Array<{
          completion: { status: string };
          kind: string;
          terminal: { tail: string };
          transport: string;
        }>;
      };

      expect(bundle.mode).toBe("live");
      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.simulations).toEqual([
        expect.objectContaining({ mode: "tui-sim", status: "passed", streamKind: "tui" })
      ]);
      const corruptedMode = ["tbrowser", "sim"].join("-");
      expect(JSON.stringify(bundle)).not.toContain(corruptedMode);
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
      expect(transcript).toContain("MIMETIC_ACTOR_VERDICT=passed");
      expect(transcript).toContain("MIMETIC_ACTOR_NONCE=");
      expect(transcript).toContain("[REDACTED_SECRET]");
      expect(transcript).not.toContain(`sk-${"testsecretvalue"}`);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("honors a blocked local Codex TUI verdict marker even when the process exits cleanly", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-blocked-actor.mjs");
      await writeFile(
        fakeActor,
        "process.stdout.write('MIMETIC_ACTOR_VERDICT=blocked MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE + '\\n');\nsetInterval(() => {}, 1000);\n",
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-tui-blocked-marker",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-tui-blocked-marker/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        review: { verdict: string };
        streams: Array<{ status: string; completion: { reason: string; status: string } }>;
      };
      expect(bundle.review.verdict).toBe("blocked");
      expect(bundle.streams[0]?.status).toBe("blocked");
      expect(bundle.streams[0]?.completion.reason).toContain("blocked verdict marker");
      expect(bundle.events.find((event) => event.type === "actor.verdict")?.message).toContain("blocked");
    });
  });

  it("publishes running Observer data while a local Codex TUI actor is active", async () => {
    await withFixtureCopy(async (cwd) => {
      const runId = "codex-tui-live-follow-test";
      const runRoot = path.join(cwd, ".mimetic/runs", runId);
      const fakeActor = path.join(cwd, "fake-codex-live-follow-actor.cjs");
      const startedFile = path.join(cwd, "actor-started");
      const releaseFile = path.join(cwd, "actor-release");
      await writeFile(
        fakeActor,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');`,
          "const timer = setInterval(() => {",
          `  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;`,
          "  clearInterval(timer);",
          "  process.stdout.write('MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE + '\\n');",
          "}, 25);"
        ].join("\n"),
        "utf8"
      );

      const runPromise = runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId,
        simCount: 1,
        timeoutMs: 5_000
      });

      await waitForFile(startedFile);
      await waitForFile(path.join(runRoot, "observer/observer-data.json"));

      const runningBundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as {
        events: Array<{ type: string }>;
        lifecycle: Array<{ event: string }>;
        review: { verdict: string };
        streams: Array<{ artifacts: Array<{ path: string }>; status: string; completion: { status: string } }>;
      };
      expect(runningBundle.review.verdict).toBe("contract_proof_only");
      expect(runningBundle.lifecycle.map((entry) => entry.event)).toContain("actor.running");
      expect(runningBundle.events.map((event) => event.type)).toContain("actor.running");
      expect(runningBundle.streams[0]?.status).toBe("running");
      expect(runningBundle.streams[0]?.completion.status).toBe("running");
      expect(runningBundle.streams[0]?.artifacts.every((artifact) => !artifact.path.includes("transcripts/"))).toBe(true);

      const runningObserverData = JSON.parse(await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")) as {
        events: Array<{ type: string }>;
        streams: Array<{ status: string }>;
      };
      expect(runningObserverData.events.map((event) => event.type)).toContain("actor.running");
      expect(runningObserverData.streams[0]?.status).toBe("running");

      const runningLatest = JSON.parse(await readFile(path.join(cwd, ".mimetic/runs/latest.json"), "utf8")) as {
        runId: string;
        path: string;
      };
      expect(runningLatest.runId).toBe(runId);
      await expect(stat(path.join(cwd, runningLatest.path, "review.md"))).resolves.toBeTruthy();

      await writeFile(releaseFile, "go", "utf8");
      const result = await runPromise;
      expect(result.ok).toBe(true);

      const latest = JSON.parse(await readFile(path.join(cwd, ".mimetic/runs/latest.json"), "utf8")) as {
        runId: string;
        path: string;
      };
      expect(latest.runId).toBe(runId);
      await expect(stat(path.join(cwd, latest.path, "run.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, latest.path, "review.md"))).resolves.toBeTruthy();

      const finalObserverData = JSON.parse(await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")) as {
        events: Array<{ type: string }>;
        streams: Array<{ artifacts: Array<{ path: string }>; status: string }>;
      };
      expect(finalObserverData.events.map((event) => event.type)).toContain("actor.verdict");
      expect(finalObserverData.streams[0]?.status).toBe("passed");
      expect(finalObserverData.streams[0]?.artifacts.some((artifact) => artifact.path.includes("transcripts/"))).toBe(true);
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

  it("runs one explicit local Codex exec actor with sanitized lifecycle evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
          "process.stdout.write('exec actor inspected mimetic/config.ts\\n');",
          "process.stdout.write('secret-like value ' + 'sk-' + 'execsecretvalue1234567890' + '\\n');",
          "process.stdout.write('{\"type\":\"turn.completed\"}\\n');"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-test",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.runId).toBe("codex-exec-test");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-test/run.json"), "utf8")
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
      expect(bundle.simulations).toEqual([expect.objectContaining({ status: "passed", streamKind: "terminal" })]);
      expect(bundle.streams).toEqual([
        expect.objectContaining({
          completion: expect.objectContaining({ status: "passed" }),
          kind: "terminal",
          transport: "snapshot"
        })
      ]);
      expect(bundle.streams[0]?.terminal.tail).toContain("exec actor inspected mimetic/config.ts");
      expect(bundle.streams[0]?.terminal.tail).toContain("[REDACTED_SECRET]");
      expect(bundle.streams[0]?.terminal.tail).not.toContain(`sk-${"execsecretvalue"}`);
      expect(bundle.events.map((event) => event.type)).toContain("actor.spawned");
      expect(bundle.events.map((event) => event.type)).toContain("actor.prompt.submitted");
      expect(bundle.events.map((event) => event.type)).toContain("actor.verdict");
      expect(bundle.events.some((event) => event.message.includes(`sk-${"execsecretvalue"}`))).toBe(false);

      const transcript = await readFile(
        path.join(cwd, ".mimetic/runs/codex-exec-test/transcripts/codex-exec-sanitized.jsonl"),
        "utf8"
      );
      expect(transcript).toContain("[REDACTED_SECRET]");
      expect(transcript).not.toContain(`sk-${"execsecretvalue"}`);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("runs explicit local Codex exec fanout with per-lane sanitized lifecycle evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-fanout-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
          "process.stdout.write('exec fanout fixture inspected mimetic dogfood docs\\n');",
          "process.stdout.write('secret-like value ' + 'sk-' + 'fanoutsecretvalue1234567890' + '\\n');",
          "process.stdout.write('{\"type\":\"turn.completed\"}\\n');"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-fanout-test",
        simCount: 4,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.simCount).toBe(4);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-fanout-test/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string; simId?: string; streamId?: string }>;
        mode: string;
        review: { verdict: string; summary: string };
        simCount: number;
        simulations: Array<{ personaId: string; status: string; streamIds: string[]; streamKind: string }>;
        streams: Array<{
          artifacts: Array<{ path: string }>;
          completion: { status: string };
          id: string;
          kind: string;
          status: string;
          terminal: { tail: string };
          transport: string;
        }>;
      };

      expect(bundle.mode).toBe("live");
      expect(bundle.simCount).toBe(4);
      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.review.summary).toContain("fanout lanes");
      expect(bundle.simulations).toHaveLength(4);
      expect(bundle.streams).toHaveLength(4);
      expect(bundle.simulations.map((simulation) => simulation.status)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed"
      ]);
      expect(bundle.simulations.map((simulation) => simulation.streamKind)).toEqual([
        "terminal",
        "terminal",
        "terminal",
        "terminal"
      ]);
      expect(new Set(bundle.simulations.map((simulation) => simulation.personaId)).size).toBe(4);
      expect(bundle.streams.map((stream) => stream.id)).toEqual([
        "sim-01-codex-exec",
        "sim-02-codex-exec",
        "sim-03-codex-exec",
        "sim-04-codex-exec"
      ]);
      expect(bundle.streams.every((stream) => stream.kind === "terminal")).toBe(true);
      expect(bundle.streams.every((stream) => stream.transport === "snapshot")).toBe(true);
      expect(bundle.streams.every((stream) => stream.completion.status === "passed")).toBe(true);
      expect(bundle.streams.every((stream) => stream.terminal.tail.includes("[REDACTED_SECRET]"))).toBe(true);
      expect(bundle.events.filter((event) => event.type === "actor.spawned")).toHaveLength(4);
      expect(bundle.events.filter((event) => event.type === "actor.prompt.submitted")).toHaveLength(4);
      expect(bundle.events.filter((event) => event.type === "actor.verdict")).toHaveLength(4);
      expect(bundle.events.some((event) => event.message.includes(`sk-${"fanoutsecretvalue"}`))).toBe(false);

      for (const stream of bundle.streams) {
        const transcriptPath = stream.artifacts.find((artifact) => artifact.path.endsWith("-sanitized.jsonl"))?.path;
        const tracePath = stream.artifacts.find((artifact) => artifact.path.endsWith(".json") && artifact.path.startsWith("actors/"))?.path;
        expect(transcriptPath).toBeTruthy();
        expect(tracePath).toBeTruthy();
        const transcript = await readFile(path.join(cwd, ".mimetic/runs/codex-exec-fanout-test", transcriptPath ?? ""), "utf8");
        expect(transcript).toContain("[REDACTED_SECRET]");
        expect(transcript).not.toContain(`sk-${"fanoutsecretvalue"}`);
        await expect(stat(path.join(cwd, ".mimetic/runs/codex-exec-fanout-test", tracePath ?? ""))).resolves.toBeTruthy();
      }

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("publishes running Observer data while local Codex exec actors are active", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-slow-actor.mjs");
      const runRoot = path.join(cwd, ".mimetic/runs/codex-exec-live-follow-test");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
          "process.stdout.write('slow exec actor started\\n');",
          "await new Promise((resolve) => setTimeout(resolve, 750));",
          "process.stdout.write('slow exec actor finished\\n');",
          "process.stdout.write('{\"type\":\"turn.completed\"}\\n');"
        ].join("\n"),
        "utf8"
      );

      const runPromise = runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-live-follow-test",
        simCount: 2,
        timeoutMs: 5_000
      });

      await waitForFile(path.join(runRoot, "observer/observer-data.json"));
      const runningBundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as {
        lifecycle: Array<{ event: string }>;
        review: { summary: string; verdict: string };
        simulations: Array<{ status: string }>;
        streams: Array<{ artifacts: Array<{ path: string }>; status: string }>;
      };
      const runningObserverData = JSON.parse(
        await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")
      ) as {
        events: Array<{ type: string }>;
        run: { status: string };
        summary: { active: number };
        streams: Array<{ status: string }>;
      };

      expect(runningBundle.review.verdict).toBe("contract_proof_only");
      expect(runningBundle.review.summary).toContain("in-progress Observer snapshot");
      expect(runningBundle.lifecycle.map((entry) => entry.event)).toContain("actor.running");
      expect(runningBundle.simulations.map((simulation) => simulation.status)).toEqual(["running", "running"]);
      expect(runningBundle.streams.map((stream) => stream.status)).toEqual(["running", "running"]);
      expect(runningBundle.streams.every((stream) => stream.artifacts.every((artifact) => !artifact.path.includes("transcripts/")))).toBe(true);
      expect(runningObserverData.run.status).toBe("contract_proof_only");
      expect(runningObserverData.summary.active).toBe(2);
      expect(runningObserverData.streams.map((stream) => stream.status)).toEqual(["running", "running"]);
      expect(runningObserverData.events.filter((event) => event.type === "actor.running")).toHaveLength(2);

      const result = await runPromise;
      expect(result.ok).toBe(true);

      const finalObserverData = JSON.parse(
        await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")
      ) as {
        events: Array<{ type: string }>;
        run: { status: string };
        summary: { active: number };
        streams: Array<{ artifacts: Array<{ path: string }>; status: string }>;
      };

      expect(finalObserverData.run.status).toBe("pass");
      expect(finalObserverData.summary.active).toBe(0);
      expect(finalObserverData.streams.map((stream) => stream.status)).toEqual(["passed", "passed"]);
      expect(finalObserverData.events.filter((event) => event.type === "actor.verdict")).toHaveLength(2);
      expect(finalObserverData.streams.every((stream) => stream.artifacts.some((artifact) => artifact.path.includes("transcripts/")))).toBe(true);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("caps local Codex exec fanout at four lanes", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, "-e", "process.exit(0)"],
        runId: "codex-exec-too-many",
        simCount: 5,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_ACTOR_FANOUT_UNIMPLEMENTED");
      await expect(stat(path.join(cwd, ".mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("exposes explicit local Codex exec actor runs through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-cli.mjs");
      const previousCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      await writeFile(
        fakeActor,
        "process.stdout.write('cli exec fixture actor passed\\n');\n",
        "utf8"
      );
      process.env.MIMETIC_CODEX_ACTOR_COMMAND = `${process.execPath} ${fakeActor}`;

      try {
        const result = await runCli([
          "run",
          "--actor",
          "codex-exec",
          "--sims",
          "1",
          "--timeout-ms",
          "5000",
          "--run-id",
          "codex-exec-cli",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout) as { mode: string; ok: boolean; runId: string };
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("live");
        expect(envelope.runId).toBe("codex-exec-cli");

        const watch = await runCli([
          "watch",
          "--run",
          "codex-exec-cli",
          "--detach",
          "--no-open",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(watch.exitCode).toBe(0);
        const observer = JSON.parse(watch.stdout) as { ok: boolean; observerPath: string };
        expect(observer.ok).toBe(true);
        expect(observer.observerPath).toBe(".mimetic/runs/codex-exec-cli/observer/index.html");
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

  it("blocks the default Codex TUI actor when only a trusted ancestor project is configured", async () => {
    await withFixtureCopy(async (cwd) => {
      const codexHome = path.join(cwd, ".codex-home");
      const fakeBin = path.join(cwd, "fake-bin");
      const fakeCodex = path.join(fakeBin, "codex");
      const spawnedSentinel = path.join(cwd, "fake-codex-spawned");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousActorCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      const previousPath = process.env.PATH;
      const trustedAncestor = path.dirname(cwd);
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        path.join(codexHome, "config.toml"),
        `[projects."${trustedAncestor.replace(/["\\]/g, "\\$&")}"]\ntrust_level = "trusted"\n`,
        "utf8"
      );
      await writeFile(
        fakeCodex,
        `#!/usr/bin/env sh\ntouch ${JSON.stringify(spawnedSentinel)}\nprintf 'fake trusted codex tui started\\n'\nprintf 'MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=%s\\n' "$MIMETIC_ACTOR_VERDICT_NONCE"\n`,
        "utf8"
      );
      await chmod(fakeCodex, 0o755);
      delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      process.env.CODEX_HOME = codexHome;
      process.env.PATH = previousPath ? `${fakeBin}${path.delimiter}${previousPath}` : fakeBin;

      try {
        const result = await runDryRun({
          cwd,
          actor: "codex-tui",
          runId: "codex-trusted-ancestor",
          simCount: 1,
          timeoutMs: 5_000
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

        const bundle = JSON.parse(
          await readFile(path.join(cwd, ".mimetic/runs/codex-trusted-ancestor/run.json"), "utf8")
        ) as {
          events: Array<{ type: string }>;
          review: { verdict: string };
          streams: Array<{ status: string; terminal: { tail: string } }>;
        };
        expect(bundle.review.verdict).toBe("blocked");
        expect(bundle.streams[0]?.status).toBe("blocked");
        expect(bundle.streams[0]?.terminal.tail).toContain("exact Codex project root");
        expect(bundle.events.map((event) => event.type)).toContain("actor.preflight.blocked");
        expect(bundle.events.map((event) => event.type)).not.toContain("actor.spawned");
        await expect(stat(spawnedSentinel)).rejects.toMatchObject({ code: "ENOENT" });

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
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
    });
  });

  it("allows the default Codex TUI actor when the exact project root is trusted", async () => {
    await withFixtureCopy(async (cwd) => {
      const codexHome = path.join(cwd, ".codex-home");
      const fakeBin = path.join(cwd, "fake-bin");
      const fakeCodex = path.join(fakeBin, "codex");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousActorCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      const previousPath = process.env.PATH;
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        path.join(codexHome, "config.toml"),
        `[projects."${cwd.replace(/["\\]/g, "\\$&")}"]\ntrust_level = "trusted"\n`,
        "utf8"
      );
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env sh\nprintf 'fake exact trusted codex tui started\\n'\nprintf 'MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=%s\\n' \"$MIMETIC_ACTOR_VERDICT_NONCE\"\n",
        "utf8"
      );
      await chmod(fakeCodex, 0o755);
      delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      process.env.CODEX_HOME = codexHome;
      process.env.PATH = previousPath ? `${fakeBin}${path.delimiter}${previousPath}` : fakeBin;

      try {
        const result = await runDryRun({
          cwd,
          actor: "codex-tui",
          runId: "codex-exact-trusted-root",
          simCount: 1,
          timeoutMs: 5_000
        });

        expect(result.ok).toBe(true);

        const bundle = JSON.parse(
          await readFile(path.join(cwd, ".mimetic/runs/codex-exact-trusted-root/run.json"), "utf8")
        ) as {
          events: Array<{ type: string }>;
          review: { verdict: string };
          streams: Array<{ status: string; terminal: { tail: string } }>;
        };
        expect(bundle.review.verdict).toBe("pass");
        expect(bundle.streams[0]?.status).toBe("passed");
        expect(bundle.streams[0]?.terminal.tail).toContain("fake exact trusted codex tui started");
        expect(bundle.events.map((event) => event.type)).toContain("actor.spawned");
        expect(bundle.events.map((event) => event.type)).not.toContain("actor.preflight.blocked");
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
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
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
