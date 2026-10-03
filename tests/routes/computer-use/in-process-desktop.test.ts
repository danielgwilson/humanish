import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import type { CuaExecutor, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "../../../src/actors/computer-use/openai-provider.js";
import { parseStudy } from "../../../src/study/config.js";
import { V2_SCHEMA } from "../../../src/study/types.js";
import { createInProcessDesktop } from "../../../src/routes/computer-use/in-process-desktop.js";
import { runCuaParticipant } from "../../../src/routes/computer-use/participant-execution.js";
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
  const parsed = parseStudy({
    schema: V2_SCHEMA,
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
  const inProcessExecutor = vi.fn(async (_appUrl: string) => executor);
  const loadDesktopModule = vi.fn(async () => {
    throw new Error("An in-process participant must never load an E2B desktop");
  });
  const deps: CuaParticipantDeps = {
    residual: parsed.config,
    labId: parsed.config.id,
    caps: {},
    brain: { kind: "caller" },
    appUrl: "http://127.0.0.1:3000/",
    subject: { kind: "app-url", appUrl: "http://127.0.0.1:3000/", publicTargets: false },
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
    desktopModule: loadDesktopModule,
    inProcessExecutor,
    onStream: async () => undefined,
    reportSubjectPhase: () => undefined,
  };
  return { spec, deps, executor, inProcessExecutor, loadDesktopModule };
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
    expect(f.inProcessExecutor).not.toHaveBeenCalled();
    const ready = await desktop.openSession();
    expect(ready).toEqual({ executor: f.executor });
    expect(f.inProcessExecutor).toHaveBeenCalledExactlyOnceWith(f.deps.appUrl);
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
    expect(f.inProcessExecutor).toHaveBeenCalledOnce();
  });

  it("shares one finalization and cannot start after it", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop(f.deps);
    const closed = desktop.finalize({ failed: true });
    expect(desktop.finalize({ failed: false })).toBe(closed);
    await closed;
    await expect(desktop.prepare()).rejects.toThrow("only start once");
    await expect(desktop.openSession()).rejects.toThrow("must be prepared");
    expect(f.inProcessExecutor).not.toHaveBeenCalled();
    expect(desktop.snapshot()).toEqual(NO_SANDBOX);
  });

  it("cannot open a prepared desktop after finalization", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop(f.deps);
    await desktop.prepare();
    await desktop.finalize({ failed: true });
    await expect(desktop.openSession()).rejects.toThrow("before finalization");
    expect(f.inProcessExecutor).not.toHaveBeenCalled();
  });

  it("keeps an executor failure and still finalizes", async () => {
    const f = await fixture();
    f.inProcessExecutor.mockRejectedValueOnce(new Error("Synthetic executor failure"));
    const desktop = createInProcessDesktop(f.deps);
    await desktop.prepare();
    await expect(desktop.openSession()).rejects.toThrow("Synthetic executor failure");
    await expect(desktop.finalize({ failed: true })).resolves.toBeUndefined();
    expect(desktop.snapshot()).toEqual(NO_SANDBOX);
  });

  it("refuses to open without an inProcess executor", async () => {
    const f = await fixture();
    const desktop = createInProcessDesktop({ appUrl: f.deps.appUrl });
    await desktop.prepare();
    await expect(desktop.openSession()).rejects.toThrow("needs RunLabOptions.inProcess");
  });

  it("runs a participant through the participant runner with one provider and no sandbox", async () => {
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
    const createProvider = vi.fn(async () => provider);
    f.deps.createProvider = createProvider;
    f.deps.createDesktop = () => createInProcessDesktop(f.deps);

    const result = await runCuaParticipant(f.spec, f.deps);

    expect(result.harnessError).toBe(false);
    expect(result.session?.status).toBe("passed");
    expect(createProvider).toHaveBeenCalledOnce();
    expect(provider.close).toHaveBeenCalledOnce();
    expect(f.inProcessExecutor).toHaveBeenCalledOnce();
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
