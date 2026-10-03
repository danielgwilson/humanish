import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The run command's handler in a real process: a live computer-use lab on a fake E2B module, its
// session hanging, gets SIGTERM. The process records the interruption, kills the journaled sandbox
// through reclaim and exits 143 itself.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function screenshot(): string {
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(200);
  return PNG.sync.write(png).toString("base64");
}

const CHILD = `
  const root = process.env.REPO_ROOT;
  const { runStudyWith } = await import(root + "/src/run-study.ts");
  const { parseStudy } = await import(root + "/src/study/config.ts");
  const { V2_SCHEMA } = await import(root + "/src/study/types.ts");
  const { beginRunSignalPhase } = await import(root + "/src/cli/commands/run-signals.ts");
  const frame = Buffer.from(process.env.PROBE_PNG, "base64");
  const noop = async () => undefined;
  const sandbox = {
    sandboxId: "sb-interrupted",
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
      kill: async (id) => { process.stdout.write("killed " + id + "\\n"); return true; },
    },
  };
  beginRunSignalPhase(
    { writeErr: (text) => process.stderr.write(text) },
    { reclaim: { loadModule: async () => module } },
  );
  const parsed = parseStudy({
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

describe("a live run with the run command's handler, signalled mid-session", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-interrupt-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("records the interruption, reclaims its sandbox and exits 143", async () => {
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
      child.kill("SIGTERM");
      expect(await exited).toBe(143);
    } finally {
      child.kill("SIGKILL");
    }
    expect(stdout.match(/killed sb-interrupted/g)).toHaveLength(1);
    const [runId] = (await readdir(path.join(cwd, ".humanish", "runs"))).filter((name) =>
      name.startsWith("cua-"),
    );
    if (runId === undefined) throw new Error(`no run directory; stderr: ${stderr}`);
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    expect(JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"))).toMatchObject({
      state: "interrupted",
      signal: "SIGTERM",
    });
    expect(
      JSON.parse(await readFile(path.join(runDir, "reclaim-receipt.json"), "utf8")),
    ).toMatchObject({ outcomes: [{ sandboxId: "sb-interrupted", state: "killed" }] });
    expect(stderr).toContain(
      `humanish: SIGTERM: run ${runId} marked interrupted; sandboxes: 1 killed.`,
    );
  });
});
