import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reclaimRunSandboxes } from "../../src/run/reclaim.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

// A library caller of runStudyWith gets no signal handler (the CLI installs one, tested in
// tests/cli/run-interrupt-child.test.ts): the process exits at once. What it leaves is the contract
// `humanish reclaim` relies on: a status record that stops refreshing and the create-time sandbox
// receipt, which reclaim kills by id. A fake E2B module stands in for the provider; its session
// never ends, so the signal lands mid-run.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function screenshot(): string {
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(200);
  return PNG.sync.write(png).toString("base64");
}

const CHILD = `
  const root = process.env.REPO_ROOT;
  const { runStudyWith } = await import(root + "/src/run-study.ts");
  const { parseStudyDocument } = await import(root + "/src/study/config.ts");
  const { V2_SCHEMA } = await import(root + "/src/study/types.ts");
  const frame = Buffer.from(process.env.PROBE_PNG, "base64");
  const noop = async () => undefined;
  const sandbox = {
    sandboxId: "fake-sb-signalled",
    getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
    commands: { run: async () => ({ exitCode: 0, stdout: "" }) },
    files: { write: noop },
    launch: noop, open: noop, wait: noop,
    screenshot: async () => frame,
    stream: { getAuthKey: () => "k", getUrl: () => "https://stream.invalid/k", start: noop },
    leftClick: noop, rightClick: noop, middleClick: noop, doubleClick: noop, moveMouse: noop,
    scroll: noop, write: noop, press: noop, drag: noop,
  };
  const module = {
    Sandbox: {
      create: async () => sandbox,
      kill: async () => { process.stdout.write("killed\\n"); return true; },
    },
  };
  const parsed = parseStudyDocument({
    schema: V2_SCHEMA,
    id: "signal-probe",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore." }],
    execution: { target: "e2b-desktop", timeoutMs: 60000, desktop: { resolution: [1280, 800] } },
    scenario: { mode: "live" },
    review: { analysis: false },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  await runStudyWith(
    parsed.config,
    {
      cwd: process.env.PROBE_CWD,
      env: { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: "synthetic-e2b" },
    },
    {
      desktopModule: async () => module,
      runSession: () => {
        process.stdout.write("session\\n");
        return new Promise(() => setInterval(() => {}, 60000));
      },
    },
  );
`;

describe("a live run signalled mid-session", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-signal-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits on %s and leaves its receipt for reclaim",
    async (signal) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", CHILD],
        {
          cwd: ROOT,
          env: { ...process.env, REPO_ROOT: ROOT, PROBE_CWD: cwd, PROBE_PNG: screenshot() },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
        child.on("exit", (code, received) => resolve(received ?? code));
      });
      try {
        await vi.waitFor(() => expect(stdout, stderr).toContain("session"), {
          timeout: 15_000,
          interval: 50,
        });
        child.kill(signal);
        expect(await exited).toBe(signal);
      } finally {
        child.kill("SIGKILL");
      }
      // No handler ran: nothing was killed, and the status record still says running.
      expect(stdout).not.toContain("killed");
      const [runId] = (await readdir(path.join(cwd, ".humanish", "runs"))).filter((name) =>
        name.startsWith("cua-"),
      );
      if (runId === undefined) throw new Error(`no run directory; stderr: ${stderr}`);
      const status = JSON.parse(
        await readFile(path.join(cwd, ".humanish", "runs", runId, "status.json"), "utf8"),
      ) as { state: string; outcome?: unknown };
      expect(status.state).toBe("running");
      expect(status.outcome).toBeUndefined();

      const killed: string[] = [];
      const reclaimed = await reclaimRunSandboxes(cwd, runId, {
        loadModule: async () =>
          ({
            Sandbox: {
              create: async () => {
                throw new Error("reclaim never creates sandboxes");
              },
              kill: async (sandboxId: string) => {
                killed.push(sandboxId);
                return true;
              },
            },
          }) as unknown as E2BDesktopModule,
      });
      expect(reclaimed.ok).toBe(true);
      expect(reclaimed.outcomes).toEqual([
        {
          sandboxId: REDACTED_SANDBOX_ID,
          sandboxIdDigest: sandboxIdDigest("fake-sb-signalled"),
          laneId: "lane-01",
          state: "killed",
        },
      ]);
      expect(killed).toEqual(["fake-sb-signalled"]);
    },
  );
});
