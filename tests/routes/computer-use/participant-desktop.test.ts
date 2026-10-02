import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActor } from "../../../src/actors/registry.js";
import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import type {
  CuaExecutor,
  CuaProvider,
  CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { describeQualifiedCodexCliVersions } from "../../../src/actors/codex/qualified-versions.js";
import { runCuaActorLab } from "../../../src/routes/computer-use/route.js";
import { runCuaParticipant } from "../../../src/routes/computer-use/lanes.js";
import { type CuaParticipantDeps } from "../../../src/routes/computer-use/types.js";
import type {
  ParticipantDesktop,
  ParticipantDesktopEvidence,
} from "../../../src/routes/computer-use/participant-desktop.js";
import { ownDesktopAllocation } from "../../../src/substrates/desktop-session.js";
import { createE2BParticipantDesktop } from "../../../src/routes/computer-use/e2b-desktop/desktop.js";
import { E2B_SPEECH_TEMPLATE } from "../../../src/substrates/e2b/sandbox.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../../src/lab/types.js";
import { parseLabConfig } from "../../../src/lab/config.js";
import {
  DEFAULT_OPENAI_CU_MODEL,
  OPENAI_RESPONSES_CU_CAPABILITIES,
} from "../../../src/actors/computer-use/openai-provider.js";
import { prepareSelectedOutputDirectory } from "../../../src/run/contained-output.js";
import { participantRun } from "../../helpers/participant-run.js";

const restrictedParticipantFactory = vi.hoisted(() => vi.fn());
vi.mock("../../../src/actors/codex/restricted-participant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/codex/restricted-participant.js")>()),
  createRestrictedCodexParticipant: restrictedParticipantFactory,
}));

const claudeSessionFactory = vi.hoisted(() => vi.fn());
vi.mock("../../../src/actors/local-agent/claude-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/local-agent/claude-session.js")>()),
  startClaudeSession: claudeSessionFactory,
}));

const temporary: string[] = [];
afterEach(async () => {
  restrictedParticipantFactory.mockReset();
  claudeSessionFactory.mockReset();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const specFields = {
  id: "participant-a",
  index: 0,
  persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "synthetic-prompt" },
  instructions: "Save a note.",
};

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-ready-desktop-"));
  temporary.push(cwd);
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "ready-desktop",
    title: "Ready desktop",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [
      { type: "openai-computer-use", persona: "first-time-visitor", mission: "Save a note." },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const { config } = parsed;
  const spec = participantRun(specFields);
  const order: string[] = [];
  const loadDesktopModule = vi.fn(async () => {
    throw new Error("The alternate port must never load an E2B desktop");
  });
  const deps: CuaParticipantDeps = {
    residual: parsed.config,
    labId: parsed.config.id,
    caps: {},
    descriptor: getActor("openai-computer-use"),
    brain: { kind: "openai", model: DEFAULT_OPENAI_CU_MODEL },
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
    scrubKnownValues: (value) => value.replaceAll("synthetic-secret-canary", "[scrubbed]"),
    runSession: vi.fn(async () => {
      throw new Error("Unexpected participant dispatch");
    }),
    now: Date.now,
    hooks: { loadDesktopModule },
    onStream: async () => undefined,
    reportSubjectPhase: () => undefined,
    signalProvisioned: (ready) => {
      order.push(`gate:${ready}`);
    },
  };
  let saved = false;
  const frame = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const backend: CuaExecutor = {
    observe: vi.fn(async () => {
      order.push("observe");
      return {
        screenshot: frame,
        stateSignature: saved ? "saved" : "empty",
        text: saved ? "Saved" : "Save note",
        url: "http://127.0.0.1:3000/notes",
      };
    }),
    execute: vi.fn(async (action, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(action).toEqual({ kind: "click", x: 8, y: 8 });
      order.push("click");
      saved = true;
    }),
  };
  const release = vi.fn(async () => {
    order.push("release");
    return { status: "released" as const, reason: "terminated" as const };
  });
  const allocation = ownDesktopAllocation({ resourceId: "synthetic-memory-desktop", release });
  let evidence: ParticipantDesktopEvidence = {
    released: false,
    streamUrlPresent: false,
    stateStepRecords: [],
    phaseRecords: [],
  };
  const port: ParticipantDesktop = {
    prepare: vi.fn(async () => {
      order.push("prepare");
    }),
    openSession: vi.fn(async () => {
      order.push("open");
      return {
        executor: allocation.open(backend).executor,
        inbox: {
          url: "http://127.0.0.1:3000/inbox",
          address: "reader@example.test",
          receiving: true,
        },
      };
    }),
    finalize: vi.fn(async () => {
      const result = await allocation.close();
      evidence = { ...evidence, released: result.status === "released" };
    }),
    snapshot: () => evidence,
  };
  deps.createDesktop = () => port;
  return { cwd, config, spec, deps, order, port, backend, allocation, release, loadDesktopModule };
}

describe("ready desktop lane contract", () => {
  it.each([
    { speech: false, template: undefined, expected: undefined },
    { speech: true, template: undefined, expected: E2B_SPEECH_TEMPLATE },
    { speech: true, template: "custom-speech-desktop", expected: "custom-speech-desktop" },
  ])(
    "selects the desktop image for speech=$speech, override=$template",
    async ({ speech, template, expected }) => {
      const f = await fixture();
      const parsed = parseLabConfig({
        ...f.config,
        actors: [
          {
            type: "local-agent",
            localAgent: "codex",
            persona: "first-time-visitor",
            mission: "Join a call.",
          },
        ],
        execution: {
          ...f.config.execution,
          desktop: {
            ...(template ? { template } : {}),
            ...(speech ? { media: { microphone: { source: "speech" } } } : {}),
          },
        },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      f.deps.residual = parsed.config;
      const create = vi.fn(async () => {
        throw new Error("synthetic allocation stop");
      });
      f.deps.hooks.loadDesktopModule = async () =>
        ({ Sandbox: { create } }) as unknown as E2BDesktopModule;
      const adapter = createE2BParticipantDesktop(f.spec, f.deps, []);
      await expect(adapter.prepare()).rejects.toThrow("synthetic allocation stop");
      expect(create).toHaveBeenCalledOnce();
      if (expected)
        expect(create).toHaveBeenCalledWith(
          expected,
          expect.objectContaining({ resolution: f.spec.planned.device.resolution }),
        );
      else
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ resolution: f.spec.planned.device.resolution }),
        );
      await adapter.finalize({ failed: true });
    },
  );

  it("refuses an unsupported hosted Codex version before creating a desktop participant", async () => {
    const f = await fixture();
    const executable = path.join(f.cwd, "codex");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst args = process.argv.slice(2).join(" ");\nif (args === "login status") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\nif (args === "--version") { process.stdout.write("codex-cli 0.153.0\\n"); process.exit(0); }\nprocess.exit(99);\n`,
    );
    await chmod(executable, 0o700);
    const parsed = parseLabConfig({
      ...f.config,
      actors: [
        {
          type: "local-agent",
          localAgent: "codex",
          persona: "first-time-visitor",
          mission: "Save a note.",
        },
      ],
      review: { analysis: false },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await runCuaActorLab({
      cwd: f.cwd,
      config: parsed.config,
      dryRun: false,
      hooks: { ...f.deps.hooks, env: { PATH: f.cwd, E2B_API_KEY: "synthetic-e2b-key" } },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(describeQualifiedCodexCliVersions());
    expect(result.error?.message).toContain("no desktop was launched");
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
    expect(restrictedParticipantFactory).not.toHaveBeenCalled();
  });

  it("refuses API-dollar caps for a hosted ChatGPT-account participant before creating a desktop", async () => {
    const f = await fixture();
    const executable = path.join(f.cwd, "codex");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst args = process.argv.slice(2).join(" ");\nif (args === "login status") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\nif (args === "--version") { process.stdout.write("codex-cli 0.157.1\\n"); process.exit(0); }\nprocess.exit(99);\n`,
    );
    await chmod(executable, 0o700);
    const parsed = parseLabConfig({
      ...f.config,
      actors: [
        {
          type: "local-agent",
          localAgent: "codex",
          persona: "first-time-visitor",
          mission: "Save a note.",
        },
      ],
      execution: { ...f.config.execution, caps: { maxUsd: 1 } },
      review: { analysis: false },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await runCuaActorLab({
      cwd: f.cwd,
      config: parsed.config,
      dryRun: false,
      hooks: { ...f.deps.hooks, env: { PATH: f.cwd, E2B_API_KEY: "synthetic-e2b-key" } },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_UNPRICED_CAP");
    expect(result.error?.message).toContain("ChatGPT-account");
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
    expect(restrictedParticipantFactory).not.toHaveBeenCalled();
  });

  it("composes hosted Codex through the shared participant factory with operator auth and declared model settings", async () => {
    const f = await fixture();
    const provider: CuaProvider = {
      id: "restricted-codex-participant",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I can read the note form.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
    };
    const close = vi.fn(async () => {
      f.order.push("model-closed");
      return { status: "confirmed" as const };
    });
    restrictedParticipantFactory.mockReturnValue({ provider, close });
    f.deps.brain = { kind: "local-agent", agent: "codex", declaredModel: "gpt-5.6-sol" };
    f.spec = participantRun({ ...specFields, limits: { reasoningEffort: "high" } });
    f.deps.env = { PATH: "/synthetic/bin", CODEX_HOME: "/synthetic/operator-codex" };
    f.deps.runSession = runCuaActorSession;

    const result = await runCuaParticipant(f.spec, f.deps);

    expect(result.harnessError).toBe(false);
    expect(restrictedParticipantFactory).toHaveBeenCalledExactlyOnceWith({
      authMode: "operator",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      session: { env: f.deps.env },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(f.order.slice(-2)).toEqual(["model-closed", "release"]);
  });

  it("records an unconfirmed shared Codex close before releasing the hosted desktop", async () => {
    const f = await fixture();
    const provider: CuaProvider = {
      id: "restricted-codex-participant",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I can read the note form.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
    };
    const close = vi.fn(async () => {
      f.order.push("model-close-unconfirmed");
      return { status: "unconfirmed" as const };
    });
    restrictedParticipantFactory.mockReturnValue({ provider, close });
    f.deps.brain = { kind: "local-agent", agent: "codex" };
    f.deps.runSession = runCuaActorSession;

    const result = await runCuaParticipant(f.spec, f.deps);

    // An unconfirmed provider cleanup is an execution failure apart from the session: it still
    // trips fail-fast (harnessError) but leaves the session's own ending alone.
    expect(result.harnessError).toBe(true);
    expect(result.providerCleanupError).toBe("Model provider cleanup is unconfirmed.");
    expect(result.sessionError).toBeUndefined();
    expect(f.order.slice(-2)).toEqual(["model-close-unconfirmed", "release"]);
  });

  it("uses the custom model on a desktop lane and closes it before the desktop", async () => {
    const f = await fixture();
    const provider: CuaProvider = {
      id: "synthetic-provider",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I can read the note form.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
      close: vi.fn(async () => {
        f.order.push("model-closed");
      }),
    };
    f.deps.createProvider = vi.fn(async (participant) => {
      expect(participant).toEqual({ id: "participant-a", index: 0, count: 1 });
      return provider;
    });
    f.deps.runSession = runCuaActorSession;
    const result = await runCuaParticipant(f.spec, f.deps);
    expect(result.harnessError).toBe(false);
    expect(provider.close).toHaveBeenCalledOnce();
    expect(f.order.slice(-2)).toEqual(["model-closed", "release"]);
  });

  it("runs a hosted Claude lane on one Claude session and closes it before the desktop", async () => {
    const f = await fixture();
    const provider: CuaProvider = {
      id: "claude-session",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I can read the note form.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
    };
    const close = vi.fn(async () => {
      f.order.push("model-closed");
    });
    claudeSessionFactory.mockResolvedValue({ provider, close });
    f.deps.brain = { kind: "local-agent", agent: "claude" };
    f.deps.runSession = runCuaActorSession;

    const result = await runCuaParticipant(f.spec, f.deps);

    expect(result.harnessError).toBe(false);
    expect(claudeSessionFactory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(f.order.slice(-2)).toEqual(["model-closed", "release"]);
  });

  it("releases the desktop even if model cleanup fails", async () => {
    const f = await fixture();
    f.deps.createProvider = async () => ({
      id: "synthetic-provider",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I see the form.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
      close: async () => {
        throw new Error("synthetic-secret-canary");
      },
    });
    f.deps.runSession = runCuaActorSession;
    const result = await runCuaParticipant(f.spec, f.deps);
    // An unconfirmed provider cleanup is an execution failure apart from the session: it still
    // trips fail-fast (harnessError) but leaves the session's own ending alone.
    expect(result.harnessError).toBe(true);
    expect(result.providerCleanupError).toBe("Model provider cleanup is unconfirmed.");
    expect(result.sessionError).toBeUndefined();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("never falls back to a hosted desktop for an unconfigured local target", async () => {
    const f = await fixture();
    const config = {
      ...f.config,
      execution: { ...f.config.execution, target: "local" as const },
    };
    expect(parseLabConfig(config).ok).toBe(true);
    const result = await runCuaActorLab({ cwd: f.cwd, config, dryRun: false, hooks: f.deps.hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_LOCAL_DESKTOP_MISSING");
    expect(result.error?.message).toContain("needs a local desktop");
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
  });

  it("asks for a local desktop only when the lab declares an app-url source", async () => {
    // A library config the parser never saw can declare another source with an appUrl, and the
    // planner then plans an app-url subject. The declared source decides, as it did in the planner.
    const f = await fixture();
    const config = {
      ...f.config,
      subject: { ...f.config.subject, source: "this-repo" },
      execution: { ...f.config.execution, target: "local" as const },
    } as unknown as LabConfig;
    const result = await runCuaActorLab({ cwd: f.cwd, config, dryRun: true, hooks: f.deps.hooks });
    expect(result.error?.code).not.toBe("HUMANISH_CUA_LAB_LOCAL_DESKTOP_MISSING");
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
  });

  const reachedProvider = async (): Promise<CuaProvider> => ({
    id: "synthetic-provider",
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    nextTurn: async () => ({
      actions: [],
      message: "REACHED THE GOAL. The save confirmation was confusing.",
      outcome: "reached",
      pendingSafetyChecks: [],
      done: true,
    }),
  });
  const localFeedbackLab = (f: Awaited<ReturnType<typeof fixture>>) => ({
    ...f.config,
    execution: { ...f.config.execution, target: "local" as const },
    review: { analysis: false as const },
  });

  it("records local desktop feedback without hosted credentials or resource claims", async () => {
    const f = await fixture();
    const result = await runCuaActorLab({
      cwd: f.cwd,
      config: localFeedbackLab(f),
      runId: "local-feedback",
      dryRun: false,
      localVm: { desktop: () => f.port, analysisRefusal: () => undefined },
      hooks: { ...f.deps.hooks, env: {} },
      createProvider: reachedProvider,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(f.cwd, ".humanish/runs/local-feedback/run.json"), "utf8"),
    );
    expect(bundle.feedbackCandidates[0].substrate).toBe("local-desktop");
    expect(bundle.providerResources).toBeUndefined();
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("records an unconfirmed local VM shutdown in status.json with its removal command", async () => {
    const f = await fixture();
    const recovery =
      "If container c1 is still listed by `docker ps`, remove it with `docker rm --force --volumes c1`.";
    const unconfirmed: ParticipantDesktop = {
      ...f.port,
      snapshot: () => ({
        ...f.port.snapshot(),
        released: false,
        sandboxRelease: {
          state: "unconfirmed",
          warning: "Local desktop cleanup is unconfirmed.",
          recovery,
        },
      }),
    };
    const result = await runCuaActorLab({
      cwd: f.cwd,
      config: localFeedbackLab(f),
      runId: "local-unconfirmed",
      dryRun: false,
      localVm: { desktop: () => unconfirmed, analysisRefusal: () => undefined },
      hooks: { ...f.deps.hooks, env: {} },
      createProvider: reachedProvider,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const status = JSON.parse(
      await readFile(path.join(f.cwd, ".humanish/runs/local-unconfirmed/status.json"), "utf8"),
    );
    expect(status.outcome.ok).toBe(true);
    expect(status.outcome.execution.warnings).toEqual([
      {
        kind: "sandbox-cleanup",
        message: `lane-01: Local desktop cleanup is unconfirmed. ${recovery}`,
      },
    ]);
  });

  it("hands the local VM's analysis refusal to automatic analysis", async () => {
    const f = await fixture();
    const run = vi.fn(
      async (
        _cwd: string,
        _runId: string,
        _config: unknown,
        deps?: { refusal?: () => string | undefined },
      ) => ({ state: "skipped" as const, reason: deps?.refusal?.() ?? null }),
    );
    // Without a review block the plan runs its default analysis.
    const config: LabConfig = localFeedbackLab(f);
    delete config.review;
    const result = await runCuaActorLab({
      cwd: f.cwd,
      config,
      dryRun: false,
      localVm: {
        desktop: () => f.port,
        analysisRefusal: () => "AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED",
      },
      automaticAnalysis: { run },
      hooks: { ...f.deps.hooks, env: {} },
      createProvider: reachedProvider,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED",
    });
  });

  it("runs a local VM's sessions on its abort signal", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    const runSession = vi.fn((options: Parameters<typeof runCuaActorSession>[0]) =>
      runCuaActorSession(options),
    );
    const result = await runCuaActorLab({
      cwd: f.cwd,
      config: localFeedbackLab(f),
      dryRun: false,
      localVm: { desktop: () => f.port, analysisRefusal: () => undefined, signal },
      hooks: { ...f.deps.hooks, env: {}, runSession },
      createProvider: reachedProvider,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(runSession).toHaveBeenCalledOnce();
    expect(runSession.mock.calls[0]![0].signal).toBe(signal);
  });

  it("runs the real participant loop and persists screenshots/trace through a non-E2B port", async () => {
    const f = await fixture();
    const requests: CuaTurnRequest[] = [];
    const provider: CuaProvider = {
      id: "synthetic-provider",
      requiresFrame: true,
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async (request) => {
        requests.push(request);
        return { actions: [{ kind: "click", x: 8, y: 8 }], pendingSafetyChecks: [], done: false };
      },
    };
    f.spec = participantRun({
      ...specFields,
      limits: { stopWhen: { any: [{ id: "saved", textIncludes: "Saved" }] } },
    });
    const onTrace = vi.fn();
    const onScreenshot = vi.fn();
    f.deps.onTrace = onTrace;
    f.deps.onScreenshot = onScreenshot;
    f.deps.runSession = (options) => runCuaActorSession({ ...options, provider });
    const result = await runCuaParticipant(f.spec, f.deps);
    expect(result.session?.reason).toBe("stopWhen matched saved (textIncludes)");
    expect(result.harnessError).toBe(false);
    expect(result.noEngagement).toBe(false);
    expect(result.killed).toBe(true);
    expect(result.sandboxId).toBeUndefined();
    expect(result.desktopResources).toBeUndefined();
    expect(result.desktopDurationMs).toBeUndefined();
    expect(f.order.slice(0, 3)).toEqual(["prepare", "open", "gate:true"]);
    expect(f.order.indexOf("click")).toBeGreaterThan(f.order.indexOf("observe"));
    expect(f.order.at(-1)).toBe("release");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.port.finalize).toHaveBeenCalledWith({ failed: false });
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.instructions).toContain("Save a note.");
    expect(requests[0]?.instructions).toContain("reader@example.test");
    expect(onTrace).toHaveBeenCalled();
    expect(onTrace.mock.calls[0]?.[0]).toBe(f.spec.planned.id);
    expect(onScreenshot).toHaveBeenCalled();
    const trace = JSON.parse(await readFile(path.join(f.cwd, "artifacts/actor.json"), "utf8"));
    expect(trace).toEqual(result.session?.trace);
    expect(result.screenshots.length).toBeGreaterThan(0);
    for (const screenshot of result.screenshots) {
      expect(PNG.sync.read(await readFile(path.join(f.cwd, "artifacts", screenshot))).width).toBe(
        16,
      );
    }
  });

  it.each(["prepare", "open", "participant"] as const)(
    "finalizes after %s failure and preserves the original error",
    async (stage) => {
      const f = await fixture();
      const fail = async () => {
        throw new Error("Synthetic failure synthetic-secret-canary");
      };
      if (stage === "prepare") f.port.prepare = fail;
      else if (stage === "open") f.port.openSession = fail;
      else f.deps.runSession = fail;
      const result = await runCuaParticipant(f.spec, f.deps);
      expect(result.harnessError).toBe(true);
      expect(result.sessionError).toBe("Synthetic failure [scrubbed]");
      expect(result.killed).toBe(true);
      expect(f.port.finalize).toHaveBeenCalledExactlyOnceWith({ failed: true });
      expect(f.order).toContain(`gate:${stage === "participant"}`);
      expect(f.backend.execute).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.loadDesktopModule).not.toHaveBeenCalled();
    },
  );

  it("does not let a failing pipeline callback skip cleanup", async () => {
    const f = await fixture();
    f.port.prepare = async () => {
      throw new Error("Synthetic setup failure");
    };
    f.deps.signalProvisioned = () => {
      throw new Error("Synthetic gate failure");
    };
    await expect(runCuaParticipant(f.spec, f.deps)).rejects.toThrow("Synthetic gate failure");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("keeps participant-reported blockers distinct from adapter failures", async () => {
    const f = await fixture();
    const provider: CuaProvider = {
      id: "synthetic-provider",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "I could not save the note because the save button is missing.",
        outcome: "blocked",
        pendingSafetyChecks: [],
        done: true,
      }),
    };
    f.deps.runSession = (options) => runCuaActorSession({ ...options, provider });
    const result = await runCuaParticipant(f.spec, f.deps);
    expect(result.harnessError).toBe(false);
    expect(result.selfReportedBlocker).toBe(true);
    expect(result.sessionError).toBeUndefined();
    expect(f.port.finalize).toHaveBeenCalledWith({ failed: false });
    expect(result.killed).toBe(true);
  });

  it("the hosted adapter retains cleanup authority after setup fails and shares finalization", async () => {
    const f = await fixture();
    const desktop = {
      sandboxId: "synthetic-hosted",
      getInfo: async () => ({ cpuCount: 2, memoryMB: 2048 }),
    } as E2BDesktopSandbox;
    const kill = vi.fn(async () => true);
    f.deps.hooks.loadDesktopModule = async () => ({
      Sandbox: { create: async () => desktop, kill },
    });
    f.deps.hooks.prepareDesktop = async () => {
      throw new Error("Synthetic setup interruption");
    };
    const adapter = createE2BParticipantDesktop(f.spec, f.deps, []);
    await expect(adapter.openSession()).rejects.toThrow("must be prepared");
    await expect(adapter.prepare()).rejects.toThrow("Synthetic setup interruption");
    const closed = adapter.finalize({ failed: true });
    expect(adapter.finalize({ failed: false })).toBe(closed);
    await closed;
    expect(kill).toHaveBeenCalledExactlyOnceWith("synthetic-hosted", { requestTimeoutMs: 60_000 });
    expect(adapter.snapshot()).toMatchObject({
      sandboxId: "synthetic-hosted",
      released: true,
      streamUrlPresent: false,
    });
    await expect(adapter.prepare()).rejects.toThrow("only start once");
    await expect(adapter.openSession()).rejects.toThrow("must be prepared");
  });

  it("a finalized hosted lane cannot allocate later", async () => {
    const f = await fixture();
    const adapter = createE2BParticipantDesktop(f.spec, f.deps, []);
    await adapter.finalize({ failed: true });
    await expect(adapter.prepare()).rejects.toThrow("only start once");
    expect(f.loadDesktopModule).not.toHaveBeenCalled();
    expect(adapter.snapshot().released).toBe(false);
  });
});
