// Each route scrubs the literal values it knows (provider keys, subject env values and the other
// values its source list names) from the evidence it writes. These tests pin, per route, which
// values are scrubbed, the marker that replaces them and the shortest value scrubbed, through one
// evidence file each. Every value is built at run time.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../../src/substrates/e2b/sdk.js";
import { passingRun, terminalConfig } from "../helpers/terminal-live-fake.js";
import { runComputerUse, runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";

/** A value with no secret shape, so only the literal scrub can remove it. */
const opaque = (label: string): string =>
  ["synthetic", label, "value", "do", "not", "leak"].join("-");
/** A value under the default four-character floor. */
const SHORT = ["q", "7", "z"].join("");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-known-secrets-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function parsed(raw: Record<string, unknown>): StudyConfig {
  const result = parseStudy(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

async function runBundle(runId: string): Promise<{ text: string; bundle: RunBundle }> {
  const text = await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8");
  return { text, bundle: JSON.parse(text) as RunBundle };
}

const cloneSubject = (env: string[]) => ({
  source: "clone",
  repos: ["example-org/example-app"],
  env,
  serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
});
/** A clone served at a public sandbox URL, which holds only seeded synthetic data. */
const syntheticCloneSubject = (env: string[]) => ({
  ...cloneSubject(env),
  exposure: "synthetic",
  state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] },
});

describe("computer use scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs both provider keys and the subject env on a dry run, and leaves a value under four characters", async () => {
    const openai = opaque("openai");
    const e2b = opaque("e2b");
    const password = opaque("password");
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "known-secrets-computer-use",
      title: "Known secrets on computer use",
      route: "computer-use",
      mode: "dry-run",
      subject: cloneSubject(["APP_PASSWORD", "APP_PIN"]),
      actor: {
        type: "openai-computer-use",
        mission: `Sign in with ${openai} ${e2b} ${password} ${SHORT}.`,
      },
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    });
    const result = await runComputerUse({
      cwd,
      config,
      dryRun: true,
      env: { OPENAI_API_KEY: openai, E2B_API_KEY: e2b, APP_PASSWORD: password, APP_PIN: SHORT },
    });
    expect(result.error).toBeUndefined();
    const { text, bundle } = await runBundle(result.runId);
    for (const value of [openai, e2b, password]) expect(text).not.toContain(value);
    expect(bundle.streams[0]?.assignment?.mission).toBe(
      `Sign in with [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
    );
  });
});

describe("shared world scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs both provider keys, the subject env and a checkpoint's redact values on a dry run", async () => {
    const openai = opaque("openai");
    const e2b = opaque("e2b");
    const password = opaque("password");
    const checkpointValue = opaque("checkpoint");
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "known-secrets-shared-world",
      title: "Known secrets on shared world",
      route: "shared-world",
      mode: "dry-run",
      subject: {
        ...cloneSubject(["APP_PASSWORD", "APP_PIN"]),
        exposure: "synthetic",
        state: {
          seed: [{ name: "migrate", command: "pnpm db:migrate" }],
          checkpoint: [{ name: "count", command: "pnpm count", redact: [checkpointValue] }],
        },
      },
      actor: {
        type: "openai-computer-use",
        mission: `Share with ${openai} ${e2b} ${password} ${checkpointValue} ${SHORT}.`,
      },
      participants: [
        { id: "participant-a", persona: "first-time-visitor", entry: "/a" },
        { id: "participant-b", persona: "returning-user", entry: "/b" },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    });
    const result = await runSharedWorld({
      cwd,
      config,
      dryRun: true,
      env: { OPENAI_API_KEY: openai, E2B_API_KEY: e2b, APP_PASSWORD: password, APP_PIN: SHORT },
    });
    expect(result.error).toBeUndefined();
    const { text, bundle } = await runBundle(result.runId);
    for (const value of [openai, e2b, password, checkpointValue]) expect(text).not.toContain(value);
    expect(bundle.streams.map((stream) => stream.assignment?.mission)).toEqual([
      `Share with [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
      `Share with [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
    ]);
  });
});

describe("terminal scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs all three keys on a dry run, and leaves a key under four characters", async () => {
    const codex = opaque("codex");
    const openai = opaque("openai");
    const config = terminalConfig({
      mode: "dry-run",
      actor: {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: `Discover with ${codex} ${openai} ${SHORT}.`,
      },
    });
    const result = await runTerminal({
      cwd,
      config,
      dryRun: true,
      env: { CODEX_API_KEY: codex, OPENAI_API_KEY: openai, E2B_API_KEY: SHORT },
    });
    expect(result.ok).toBe(true);
    const { bundle } = await runBundle(result.runId);
    expect(bundle.streams[0]?.assignment).toEqual({
      mission: `Discover with [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
    });
  });

  it("scrubs the runtime key and the E2B key from a live run's mission and terminal output", async () => {
    const runtimeKey = opaque("runtime");
    const e2b = opaque("e2b");
    const config = terminalConfig({
      actor: {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: `Discover with ${runtimeKey} ${e2b}.`,
      },
    });
    const run = passingRun({ env: { OPENAI_API_KEY: runtimeKey, E2B_API_KEY: e2b } });
    const result = await runTerminal({ cwd, config, dryRun: false, ...run });
    expect(result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const { bundle } = await runBundle(result.runId);
    expect(bundle.streams[0]?.assignment).toEqual({
      mission: "Discover with [REDACTED_SECRET] [REDACTED_SECRET].",
    });
    for (const file of ["run.json", "terminal-ledgers.json", "terminal-events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(runtimeKey);
      expect(text, file).not.toContain(e2b);
    }
  });
});

describe("scripted scrubs its known values with [redacted]", () => {
  it("scrubs the clone repo and every non-empty subject env value from a live run's session error", async () => {
    const password = opaque("password");
    const repo = "example-org/example-app";
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "known-secrets-scripted",
      title: "Known secrets on scripted",
      route: "scripted",
      mode: "live",
      subject: syntheticCloneSubject(["APP_PASSWORD", "APP_PIN"]),
      actor: { type: "scripted-browser", persona: "synthetic-new-user" },
      surfaces: ["desktop"],
      scenario: "scripted-first-run",
      execution: { target: "e2b-desktop", timeoutMs: 30_000 },
    });
    await writeScenario(cwd);
    const result = await runScripted({
      cwd,
      config,
      dryRun: false,
      env: { E2B_API_KEY: opaque("e2b"), APP_PASSWORD: password, APP_PIN: SHORT },
      deps: {
        desktopModule: async () => subjectModule(),
        browserCommand: "/synthetic/browser",
        detachedTimers: { now: () => 0, sleep: async () => undefined },
        runScriptedSession: async () => {
          throw new Error(`session failed on ${repo} with ${password} and ${SHORT}`);
        },
      },
    });
    expect(result.ok).toBe(false);
    const { text } = await runBundle(result.runId);
    expect(text).not.toContain(password);
    expect(text).toContain("session failed on [redacted] with [redacted] and [redacted]");
  });
});

/** The committed demo scenario, copied so the run binds to the real file. */
async function writeScenario(root: string): Promise<void> {
  const source = path.join(process.cwd(), "humanish", "scenarios", "scripted-first-run.yaml");
  await mkdir(path.join(root, "humanish", "scenarios"), { recursive: true });
  await writeFile(
    path.join(root, "humanish", "scenarios", "scripted-first-run.yaml"),
    await readFile(source, "utf8"),
    "utf8",
  );
}

/** A subject sandbox that clones, installs and serves without doing anything. */
function subjectModule(): E2BDesktopModule {
  const sandbox = {
    sandboxId: "fake-subject-001",
    commands: {
      run: async (command: string) => {
        if (command.includes("/status")) return { exitCode: 0, stdout: "0\n" };
        if (command.includes("rev-parse")) return { exitCode: 0, stdout: "12".repeat(20) + "\n" };
        if (command.includes("curl")) return { exitCode: 0, stdout: "READY\n" };
        return { exitCode: 0, stdout: "" };
      },
    },
    files: { write: async () => undefined },
    launch: async () => undefined,
    open: async () => undefined,
    getHost: (port: number) => `${port}-fake-subject-001.e2b.app`,
    screenshot: async () => new Uint8Array([1, 2, 3, 4]),
    wait: async () => undefined,
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => undefined,
    },
  } as unknown as E2BDesktopSandbox;
  return {
    Sandbox: {
      create: async () => sandbox,
      kill: async () => true,
      list: () => ({ hasNext: false, nextItems: async () => [] }),
    },
  } as unknown as E2BDesktopModule;
}
