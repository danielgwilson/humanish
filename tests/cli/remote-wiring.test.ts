import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

// `humanish run` from its arguments to the launcher: the launcher is replaced, so no runner is
// created, and this humanish counts as a built package a runner could install.
const launches = vi.hoisted(() => ({
  calls: [] as { study: string; provider: string }[],
  outcome: undefined as unknown,
}));
const modal = vi.hoisted(() => ({ missing: false }));
vi.mock("../../src/substrates/modal/sdk.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/substrates/modal/sdk.js")>();
  return {
    ...original,
    loadModalModule: () =>
      modal.missing
        ? Promise.reject(new Error("Running on Modal requires the optional peer modal."))
        : original.loadModalModule(),
  };
});
vi.mock("../../src/remote/launch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/remote/launch.js")>()),
  runsFromPackage: () => true,
  launchRemoteRun: async (launch: { study: string; remote: { provider: string } }) => {
    launches.calls.push({ study: launch.study, provider: launch.remote.provider });
    return launches.outcome;
  },
}));

import { createProgram } from "../../src/cli/program.js";
import { discoverProviderKeys } from "../../src/keys/key-resolution.js";
import { lab, SCENARIO_YAML } from "../admission/fixtures.js";

let home: string;
let cwd: string;
beforeEach(async () => {
  launches.calls.length = 0;
  modal.missing = false;
  home = await mkdtemp(path.join(tmpdir(), "humanish-remote-wiring-home-"));
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-remote-wiring-"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv("HUMANISH_INSIDE_RUNNER", undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  vi.stubEnv("MODAL_TOKEN_ID", "synthetic-modal-id");
  vi.stubEnv("MODAL_TOKEN_SECRET", "synthetic-modal-secret");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** A live terminal study on E2B, which a run places remotely. */
async function terminalStudy(): Promise<string> {
  const raw = lab("terminal", { mode: "live", execution: { runtimeAuth: "openai-egress" } });
  await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "studies", `${String(raw.id)}.yaml`), stringify(raw));
  return String(raw.id);
}

/** A computer-use study on Modal desktops against a public app: one a run places remotely. */
async function remoteStudy(): Promise<string> {
  const raw = lab("cuAppUrl", {
    mode: "live",
    subject: { source: "app-url", appUrl: "https://app.example.com/" },
    policies: { allowPublicTargets: true },
    execution: { target: "modal-desktop", timeoutMs: 300_000 },
    review: { analysis: false },
  });
  await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  await writeFile(path.join(cwd, "humanish", "studies", `${String(raw.id)}.yaml`), stringify(raw));
  return String(raw.id);
}

async function run(args: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
    keyDiscovery: (options) =>
      discoverProviderKeys({ ...options, deps: { homeDir: home, execText: async () => null } }),
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", "run", ...args, "--cwd", cwd], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  const out = stdout.join("");
  return {
    exitCode,
    stderr: stderr.join(""),
    json: out.trim().startsWith("{") ? (JSON.parse(out) as Record<string, unknown>) : undefined,
  };
}

const PASSED = {
  schema: "humanish.run-result.v1",
  ok: true,
  cwd: "/runner/project",
  runId: "cua-remote",
  warnings: [],
};

describe("humanish run on a study that runs remotely", () => {
  it("launches it on the study's provider and reports the runner's result with the keys sent", async () => {
    const id = await remoteStudy();
    launches.outcome = { runId: "cua-remote", exitCode: 0, result: PASSED, files: 12 };
    const { exitCode, stderr, json } = await run([id, "--json"]);
    expect(launches.calls).toEqual([{ study: `humanish/studies/${id}.yaml`, provider: "modal" }]);
    expect(exitCode).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      runId: "cua-remote",
      cwd: path.resolve(cwd),
      remote: { provider: "modal", keys: expect.arrayContaining(["OPENAI_API_KEY"]) },
    });
    // The command names the keys before the runner starts, and never prints their values.
    expect(stderr).toMatch(/OPENAI_API_KEY/);
    expect(stderr).not.toMatch(/synthetic-/);
  });

  it("exits 129 with the detached code when the terminal closes and the run goes on", async () => {
    const id = await remoteStudy();
    launches.outcome = { runId: "cua-remote", exitCode: 129, detached: true };
    const { exitCode, json } = await run([id, "--json"]);
    expect(exitCode).toBe(129);
    expect(json).toMatchObject({ ok: false, error: { code: "HUMANISH_REMOTE_DETACHED" } });
  });

  it("refuses --remote with an option a remote run does not carry, before any runner", async () => {
    const id = await remoteStudy();
    const { exitCode, json } = await run([id, "--remote", "--count", "2", "--json"]);
    expect(launches.calls).toEqual([]);
    expect(exitCode).toBe(2);
    expect(json).toMatchObject({ ok: false, error: { code: "HUMANISH_REMOTE_REFUSED" } });
  });

  it("refuses a study this machine would refuse before any runner, with the route's own code", async () => {
    const id = await remoteStudy();
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const { json } = await run([id, "--json"]);
    expect(launches.calls).toEqual([]);
    expect(json).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_COMPUTER_USE_KEYS_MISSING" },
    });
  });

  it("refuses a run whose provider SDK is not installed before it names a run", async () => {
    const id = await remoteStudy();
    modal.missing = true;
    const { exitCode, json } = await run([id, "--json"]);
    expect(launches.calls).toEqual([]);
    expect(exitCode).toBe(2);
    expect(json).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_REMOTE_REFUSED", message: expect.stringContaining("peer modal") },
    });
    await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
  });

  it("launches a live terminal study on its shell sandbox's provider", async () => {
    vi.stubEnv("E2B_API_KEY", "synthetic-e2b-key");
    const id = await terminalStudy();
    launches.outcome = { runId: "terminal-remote", exitCode: 0, result: PASSED, files: 9 };
    const { exitCode, json } = await run([id, "--json"]);
    expect(launches.calls).toEqual([{ study: `humanish/studies/${id}.yaml`, provider: "e2b" }]);
    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ ok: true, remote: { provider: "e2b" } });
  });

  it("keeps a dry run here, whatever asked for a remote one", async () => {
    const id = await remoteStudy();
    const { json } = await run([id, "--remote", "--dry-run", "--json"]);
    expect(launches.calls).toEqual([]);
    expect(json).toMatchObject({ ok: true });
    expect(json).not.toHaveProperty("remote");
  });
});
