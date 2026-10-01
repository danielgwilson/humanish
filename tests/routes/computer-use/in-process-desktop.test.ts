import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import type { CuaExecutor, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "../../../src/actors/computer-use/openai-provider.js";
import { getActor } from "../../../src/actors/registry.js";
import { parseLabConfig } from "../../../src/lab/config.js";
import { LAB_CONFIG_SCHEMA } from "../../../src/lab/types.js";
import { createInProcessDesktop } from "../../../src/routes/computer-use/in-process-desktop.js";
import { runCuaParticipant } from "../../../src/routes/computer-use/lanes.js";
import type { CuaParticipantDeps } from "../../../src/routes/computer-use/types.js";
import { prepareSelectedOutputDirectory } from "../../../src/run/contained-output.js";
import { participantRun } from "../../helpers/participant-run.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-in-process-desktop-"));
  temporary.push(cwd);
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "in-process-desktop",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [
      { type: "openai-computer-use", persona: "first-time-visitor", mission: "Save a note." },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const spec = participantRun({
    id: "participant-a",
    index: 0,
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "synthetic-prompt" },
    instructions: "Save a note.",
  });
  const frame = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const executor: CuaExecutor = {
    observe: vi.fn(async () => ({
      screenshot: frame,
      stateSignature: "notes",
      text: "Save note",
      url: "http://127.0.0.1:3000/notes",
    })),
    execute: vi.fn(async () => undefined),
  };
  const buildExecutor = vi.fn(async () => executor);
  const loadDesktopModule = vi.fn(async () => {
    throw new Error("An in-process participant must never load an E2B desktop");
  });
  const deps: CuaParticipantDeps = {
    config: parsed.config,
    descriptor: getActor("openai-computer-use"),
    brain: { kind: "caller" },
    appUrl: "http://127.0.0.1:3000/",
    cloneRoute: false,
    subjectEnvNames: [],
    hasGithubToken: false,
    env: {},
    openaiApiKey: "",
    e2bApiKey: "",
    requestTimeoutMs: 60_000,
    sandboxMs: 60_000,
    timeoutMs: 60_000,
    participantCount: 1,
    artifactRoot: await prepareSelectedOutputDirectory(cwd, "artifacts"),
    labCwd: cwd,
    redactScreenshots: false,
    scrubKnownValues: (value) => value,
    runSession: runCuaActorSession,
    now: Date.now,
    hooks: { buildExecutor, loadDesktopModule },
  };
  return { spec, deps, executor, buildExecutor, loadDesktopModule };
}

const NO_SANDBOX = {
  released: false,
  streamUrlPresent: false,
  stateStepRecords: [],
  phaseRecords: [],
};

describe("in-process participant desktop", () => {
  it("acquires nothing when created or prepared, then builds the caller's executor once", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop(f.deps);
    await desktop.prepare();
    expect(f.buildExecutor).not.toHaveBeenCalled();
    const ready = await desktop.openSession();
    expect(ready).toEqual({ executor: f.executor });
    expect(f.buildExecutor).toHaveBeenCalledExactlyOnceWith({
      config: f.deps.config,
      actor: f.deps.descriptor,
      appUrl: f.deps.appUrl,
    });
    await desktop.finalize({ failed: false });
    expect(desktop.snapshot()).toEqual(NO_SANDBOX);
  });

  it("refuses to open before prepare, to open twice, and to prepare twice", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop(f.deps);
    await expect(desktop.openSession()).rejects.toThrow("must be prepared");
    await desktop.prepare();
    await expect(desktop.prepare()).rejects.toThrow("only start once");
    await desktop.openSession();
    await expect(desktop.openSession()).rejects.toThrow("may only be opened once");
    expect(f.buildExecutor).toHaveBeenCalledOnce();
  });

  it("shares one finalization and cannot start after it", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop(f.deps);
    const closed = desktop.finalize({ failed: true });
    expect(desktop.finalize({ failed: false })).toBe(closed);
    await closed;
    await expect(desktop.prepare()).rejects.toThrow("only start once");
    await expect(desktop.openSession()).rejects.toThrow("must be prepared");
    expect(f.buildExecutor).not.toHaveBeenCalled();
    expect(desktop.snapshot()).toEqual(NO_SANDBOX);
  });

  it("cannot open a prepared desktop after finalization", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop(f.deps);
    await desktop.prepare();
    await desktop.finalize({ failed: true });
    await expect(desktop.openSession()).rejects.toThrow("before finalization");
    expect(f.buildExecutor).not.toHaveBeenCalled();
  });

  it("keeps an executor failure and still finalizes", async () => {
    const f = await fixture();
    f.buildExecutor.mockRejectedValueOnce(new Error("Synthetic executor failure"));
    const desktop = createInProcessDesktop(f.deps);
    await desktop.prepare();
    await expect(desktop.openSession()).rejects.toThrow("Synthetic executor failure");
    await expect(desktop.finalize({ failed: true })).resolves.toBeUndefined();
    expect(desktop.snapshot()).toEqual(NO_SANDBOX);
  });

  it("refuses to open without a buildExecutor hook", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop({ ...f.deps, hooks: {} });
    await desktop.prepare();
    await expect(desktop.openSession()).rejects.toThrow("needs hooks.buildExecutor");
  });

  it("runs a participant through the lane runner with one provider and no sandbox", async () => {
    const f = await fixture();
    const provider: CuaProvider = {
      id: "synthetic-in-process-model",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I can read the note form.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
      close: vi.fn(async () => undefined),
    };
    const buildProvider = vi.fn(async () => provider);
    f.deps.hooks.buildProvider = buildProvider;
    f.deps.createDesktop = () => createInProcessDesktop(f.deps);

    const result = await runCuaParticipant(f.spec, f.deps);

    expect(result.harnessError).toBe(false);
    expect(result.session?.status).toBe("passed");
    expect(buildProvider).toHaveBeenCalledOnce();
    expect(provider.close).toHaveBeenCalledOnce();
    expect(f.buildExecutor).toHaveBeenCalledOnce();
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
    expect(result).toMatchObject({ killed: false, streamUrlPresent: false });
    for (const field of [
      "sandboxId",
      "desktopDurationMs",
      "desktopResources",
      "subjectCommit",
      "recording",
    ] as const)
      expect(result[field]).toBeUndefined();
  });
});
