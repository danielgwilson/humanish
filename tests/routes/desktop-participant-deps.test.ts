// What computer use and shared world hand each participant's runner, read through the routes. Both
// routes build the deps one participant reads (its brain, keys, timeouts, scrubber, run budget and
// seams), and each adds its own overrides. A route that dropped a field ran a local-agent shared
// world on the OpenAI key once, and the memory contract test fakes each brain past this wiring, so
// these run each route with a fake desktop and read the deps its participants received.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../src/actors/computer-use/actor.js";
import type { CuaExecutor, CuaProvider } from "../../src/actors/computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "../../src/actors/computer-use/openai-provider.js";
import { createRestrictedCodexParticipant } from "../../src/actors/codex/restricted-participant.js";
import { startClaudeSession } from "../../src/actors/local-agent/claude-session.js";
import { startParticipantModel } from "../../src/routes/computer-use/participant-model.js";
import type { ParticipantDesktop } from "../../src/routes/computer-use/participant-desktop.js";
import type { CuaParticipantDeps } from "../../src/routes/computer-use/types.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { StudyDeps } from "../../src/study/study-deps.js";
import { defaultSubjectPhaseSink } from "../../src/subject/steps.js";
import { ownDesktopAllocation } from "../../src/substrates/desktop-session.js";
import { e2bRequestTimeoutMs } from "../../src/substrates/e2b/lifetime.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { runComputerUse, runSharedWorld } from "../helpers/route-run.js";

vi.mock("../../src/routes/computer-use/e2b-desktop/desktop.js", () => ({
  createE2BParticipantDesktop: vi.fn(() => fakeDesktop()),
}));
vi.mock("../../src/routes/computer-use/participant-model.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/routes/computer-use/participant-model.js")>();
  return { ...actual, startParticipantModel: vi.fn(actual.startParticipantModel) };
});
vi.mock("../../src/actors/codex/restricted-participant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/codex/restricted-participant.js")>()),
  createRestrictedCodexParticipant: vi.fn(),
}));
vi.mock("../../src/actors/local-agent/claude-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/local-agent/claude-session.js")>()),
  startClaudeSession: vi.fn(),
}));
// The local CLIs are not installed here; their readiness is tested on its own.
vi.mock("../../src/actors/local-agent/readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/local-agent/readiness.js")>()),
  localAgentRefusal: vi.fn(async () => undefined),
}));

const LOBBY_URL = "https://lobby-trivia.example.test/lobby/AB2CD9";
const ENV = {
  OPENAI_API_KEY: "synthetic-openai-key",
  E2B_API_KEY: "synthetic-e2b-key",
  DATABASE_URL: "postgres://synthetic-database",
} as const;

/** The URL each fake participant desktop reports; the external-public host latches its code from it. */
let observedUrl = "http://127.0.0.1:3000/";

function doneProvider(id: string): CuaProvider {
  return {
    id,
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    nextTurn: async () => ({
      actions: [],
      message: "Done.",
      outcome: "reached",
      pendingSafetyChecks: [],
      done: true,
    }),
  };
}

function fakeExecutor(): CuaExecutor {
  const screenshot = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  return {
    observe: async () => ({ screenshot, stateSignature: "page", text: "Notes", url: observedUrl }),
    execute: async () => undefined,
  };
}

/** A participant desktop that acquires nothing, in place of the E2B one and the local VM's. */
function fakeDesktop(): ParticipantDesktop {
  const allocation = ownDesktopAllocation({
    resourceId: "synthetic-desktop",
    release: async () => ({ status: "released" as const, reason: "terminated" as const }),
  });
  let released = false;
  return {
    prepare: async () => undefined,
    openSession: async () => ({ executor: allocation.open(fakeExecutor()).executor }),
    finalize: async () => {
      released = (await allocation.close()).status === "released";
    },
    snapshot: () => ({ released, streamUrlPresent: false, stateStepRecords: [], phaseRecords: [] }),
  };
}

/** The provisioned plane's one subject sandbox. Participants get fake desktops above. */
function fakeSubjectModule(): E2BDesktopModule {
  let reads = 0;
  const handle = (command: string): { stdout?: string } | undefined => {
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("curl")) return { stdout: "READY" };
    // Each read sees a newer world, so the run finds the shared state changed.
    if (command.includes("checkpoint-") && command.includes("tail -c"))
      return { stdout: `world=${(reads += 1)}\n` };
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
  const sandbox = (id: string) =>
    ({
      sandboxId: id,
      commands: { run: async (command: string) => handle(command) ?? { exitCode: 0, stdout: "" } },
      files: { write: async () => undefined },
      getHost: (port: number) => `${port}-${id}.e2b.app`,
    }) as unknown as E2BDesktopSandbox;
  return {
    Sandbox: {
      create: async (_template: string | E2BDesktopCreateOptions) => sandbox("subject-sandbox"),
      kill: async () => true,
    },
  } as unknown as E2BDesktopModule;
}

/** The seams every run gets, so the deps can be checked against them by identity. */
function seams(): StudyDeps & { now: () => number } {
  return {
    // Shared world measures each participant's window on this clock.
    now: () => Date.now(),
    desktopModule: async () => fakeSubjectModule(),
    detachedTimers: { now: () => 0, sleep: async () => {} },
    proberCadenceMs: 100_000,
    readLobbyCodeFromFrame: async () => undefined,
    subjectPhaseSink: () => {},
  };
}

function parsed(study: Record<string, unknown>): StudyConfig {
  const result = parseStudy(study);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const OPENAI = { type: "openai-computer-use" };
const CODEX = { type: "local-agent", localAgent: "codex" };
const CLAUDE = { type: "local-agent", localAgent: "claude" };

function computerUseStudy(actor: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parsed({
    schema: STUDY_SCHEMA,
    id: "desktop-deps-computer-use",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { ...actor, mission: "Save a note." },
    participants: [
      { id: "first", persona: "first-time-visitor" },
      { id: "second", persona: "impatient-skimmer" },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    review: { analysis: false },
    ...extra,
  });
}

function provisionedStudy(actor: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parsed({
    schema: STUDY_SCHEMA,
    id: "desktop-deps-shared-world",
    route: "shared-world",
    mode: "live",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: {
        install: "pnpm install",
        start: "pnpm start -H 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "psql query notes" }],
      },
    },
    actor: { ...actor, mission: "Use the shared app." },
    participants: [
      { id: "persona-01", persona: "persona-1" },
      { id: "persona-02", persona: "persona-2" },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    review: { analysis: false },
    ...extra,
  });
}

function externalPublicStudy() {
  return parsed({
    schema: STUDY_SCHEMA,
    id: "desktop-deps-external-public",
    route: "shared-world",
    mode: "live",
    subject: {
      source: "app-url",
      appUrl: "https://lobby-trivia.example.test/",
      publicTarget: { owner: "example-operator/lobby-trivia", authorized: true },
    },
    policies: { allowPublicTargets: true },
    actor: { ...OPENAI, mission: "Play the example multiplayer app with your friends." },
    participants: [
      { id: "host", host: true, persona: "party-host", instruction: "Create a lobby." },
      { id: "player-2", persona: "casual-friend", instruction: "Join the lobby." },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    review: { analysis: false },
  });
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-desktop-deps-"));
  observedUrl = "http://127.0.0.1:3000/";
  vi.mocked(createRestrictedCodexParticipant).mockReturnValue({
    provider: doneProvider("codex-participant"),
    close: async () => ({ status: "confirmed" as const }),
  } as unknown as ReturnType<typeof createRestrictedCodexParticipant>);
  vi.mocked(startClaudeSession).mockResolvedValue({
    provider: doneProvider("claude-session"),
    close: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof startClaudeSession>>);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * A session runner that records its options and ends on the first turn. With `together`, each
 * session waits until that many have started and then holds for a moment, so shared world sees
 * its participants live at the same time.
 */
function recordingSessions(together = 1) {
  const sessions: CuaActorSessionOptions[] = [];
  let release: () => void = () => {};
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runSession = async (options: CuaActorSessionOptions) => {
    sessions.push(options);
    // An external-public host yields its lobby code before its followers start.
    options.onObservedUrl?.(observedUrl);
    if (sessions.length >= together) release();
    await everyone;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    return runCuaActorSession({ ...options, provider: options.provider ?? doneProvider("api") });
  };
  return { sessions, runSession };
}

/** The deps each participant's model started with, by participant id. */
function participantDeps(): Map<string, CuaParticipantDeps> {
  return new Map(
    vi
      .mocked(startParticipantModel)
      .mock.calls.map(([spec, deps]) => [spec.planned.id, deps as CuaParticipantDeps]),
  );
}

/** One deps value per participant: the fields both of them must share. */
function onlyDeps(byId: Map<string, CuaParticipantDeps>): CuaParticipantDeps {
  const [first, ...rest] = [...byId.values()];
  for (const other of rest) {
    expect(other.runBudget).toBe(first!.runBudget);
    expect(other.scrubKnownValues).toBe(first!.scrubKnownValues);
    expect(other.brain).toBe(first!.brain);
  }
  return first!;
}

const keysOf = (deps: CuaParticipantDeps) => Object.keys(deps).sort();

/** The fields both routes hand every participant, from the same sources. */
const SHARED_KEYS = [
  "artifactRoot",
  "brain",
  "caps",
  "detachedTimers",
  "desktopModule",
  "e2bApiKey",
  "env",
  "now",
  "onStream",
  "onTrace",
  "openaiApiKey",
  "participantCount",
  "prepareDesktop",
  "redactScreenshots",
  "reportSubjectPhase",
  "requestTimeoutMs",
  "residual",
  "runSession",
  "sandboxMs",
  "scrubKnownValues",
  "studyCwd",
  "studyId",
  "subject",
  "timeoutMs",
];

describe("computer use hands each participant the run's deps", () => {
  it("an openai brain on E2B desktops: keys, caps, one run budget and the seams", async () => {
    const { sessions, runSession } = recordingSessions();
    const deps = { ...seams(), runSession };
    const prepareDesktop = async () => undefined;
    const result = await runComputerUse({
      cwd,
      config: computerUseStudy(OPENAI, { caps: { maxUsd: 1, maxTotalUsd: 2 } }),
      dryRun: false,
      env: ENV,
      prepareDesktop,
      deps,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const byId = participantDeps();
    expect([...byId.keys()].sort()).toEqual(["first", "second"]);
    const shared = onlyDeps(byId);
    expect(keysOf(shared)).toEqual([...SHARED_KEYS, "appUrl", "runBudget", "signalReady"].sort());
    expect(shared.brain).toEqual({ kind: "openai", model: expect.any(String) });
    expect(shared.openaiApiKey).toBe(ENV.OPENAI_API_KEY);
    expect(shared.e2bApiKey).toBe(ENV.E2B_API_KEY);
    expect(shared.caps).toEqual({ maxUsd: 1, maxTotalUsd: 2 });
    expect(shared.runBudget?.maxTotalUsd).toBe(2);
    expect(shared.subject).toMatchObject({ kind: "app-url", appUrl: "http://127.0.0.1:3000/" });
    expect(shared.appUrl).toBe("http://127.0.0.1:3000/");
    expect(shared.studyId).toBe("desktop-deps-computer-use");
    expect(shared.participantCount).toBe(2);
    expect(shared.timeoutMs).toBe(60_000);
    expect(shared.sandboxMs).toBeGreaterThan(60_000);
    expect(shared.requestTimeoutMs).toBe(e2bRequestTimeoutMs(ENV));
    // The requested cwd, as the caller passed it.
    expect(shared.studyCwd).toBe(cwd);
    expect(shared.redactScreenshots).toBe(false);
    expect(shared.screenMismatchPolicy).toBeUndefined();
    expect(shared.scrubKnownValues(`key ${ENV.OPENAI_API_KEY} ${ENV.E2B_API_KEY}`)).not.toMatch(
      /synthetic-(openai|e2b)-key/,
    );
    expect(shared.now).toBe(deps.now);
    expect(shared.desktopModule).toBe(deps.desktopModule);
    expect(shared.detachedTimers).toBe(deps.detachedTimers);
    expect(shared.prepareDesktop).toBe(prepareDesktop);

    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.provider).toBeUndefined();
      expect(session.openai?.apiKey).toBe(ENV.OPENAI_API_KEY);
      expect(session.maxUsd).toBe(1);
      expect(session.estimateTurnCostUsd).toBeDefined();
      expect(session.overRunBudget).toBeDefined();
      expect(session.signal).toBeUndefined();
    }
  });

  it("no run budget without caps.maxTotalUsd", async () => {
    const { runSession } = recordingSessions();
    await runComputerUse({
      cwd,
      config: computerUseStudy(OPENAI),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession },
    });
    const shared = onlyDeps(participantDeps());
    expect(shared.runBudget).toBeUndefined();
    expect(keysOf(shared)).toEqual(
      [...SHARED_KEYS, "appUrl", "signalReady"].filter((key) => key !== "prepareDesktop").sort(),
    );
  });

  it.each([
    { actor: CODEX, agent: "codex", provider: "codex-participant" },
    { actor: CLAUDE, agent: "claude", provider: "claude-session" },
  ])("a $agent local agent drives each participant", async ({ actor, agent, provider }) => {
    const { sessions, runSession } = recordingSessions();
    const result = await runComputerUse({
      cwd,
      config: computerUseStudy(actor),
      dryRun: false,
      env: { E2B_API_KEY: ENV.E2B_API_KEY },
      deps: { ...seams(), runSession },
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const shared = onlyDeps(participantDeps());
    expect(shared.brain).toEqual({ kind: "local-agent", agent });
    expect(shared.openaiApiKey).toBe("");
    expect(sessions.map((session) => session.provider?.id)).toEqual([provider, provider]);
  });
});

describe("each route hands the study's longest wait to its participants", () => {
  it("computer use: each session and each Codex participant", async () => {
    const { sessions, runSession } = recordingSessions();
    const result = await runComputerUse({
      cwd,
      config: computerUseStudy({ ...CODEX, maxWaitMs: 90_000 }),
      dryRun: false,
      env: { E2B_API_KEY: ENV.E2B_API_KEY },
      deps: { ...seams(), runSession },
    });
    expect(result.error).toBeUndefined();
    expect(sessions.map((session) => session.maxWaitMs)).toEqual([90_000, 90_000]);
    // The Codex tool description states the same limit the loop applies.
    expect(
      vi.mocked(createRestrictedCodexParticipant).mock.calls.map(([options]) => options?.maxWaitMs),
    ).toEqual([90_000, 90_000]);
  });

  it("shared world: each session", async () => {
    const { sessions, runSession } = recordingSessions(2);
    const result = await runSharedWorld({
      cwd,
      config: provisionedStudy({ ...OPENAI, maxWaitMs: 90_000 }),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession },
    });
    expect(result.error).toBeUndefined();
    expect(sessions.map((session) => session.maxWaitMs)).toEqual([90_000, 90_000]);
  });

  it("computer use and shared world: the study's idle wait, to each session", async () => {
    const cu = recordingSessions();
    const shared = recordingSessions(2);
    const cuResult = await runComputerUse({
      cwd,
      config: computerUseStudy({ ...OPENAI, idleWaitMs: 15_000 }),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession: cu.runSession },
    });
    const sharedResult = await runSharedWorld({
      cwd,
      config: provisionedStudy({ ...OPENAI, idleWaitMs: 15_000 }),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession: shared.runSession },
    });
    expect(cuResult.error).toBeUndefined();
    expect(sharedResult.error).toBeUndefined();
    expect(cu.sessions.map((session) => session.idleWaitMs)).toEqual([15_000, 15_000]);
    expect(shared.sessions.map((session) => session.idleWaitMs)).toEqual([15_000, 15_000]);
  });

  it("no limit is passed when the study sets none, so the loop's default applies", async () => {
    const { sessions, runSession } = recordingSessions();
    await runComputerUse({
      cwd,
      config: computerUseStudy(OPENAI),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession },
    });
    expect(sessions.map((session) => session.maxWaitMs)).toEqual([undefined, undefined]);
    expect(sessions.map((session) => session.idleWaitMs)).toEqual([undefined, undefined]);
  });
});

describe("computer use hands a caller's brain to each participant", () => {
  it("a caller's provider on the local VM, with the VM's signal on every session", async () => {
    const { sessions, runSession } = recordingSessions();
    const controller = new AbortController();
    const provider = doneProvider("caller-provider");
    const createDesktop = () => fakeDesktop();
    const config = computerUseStudy(OPENAI);
    const result = await runComputerUse({
      cwd,
      config: { ...config, execution: { ...config.execution, target: "local" } },
      dryRun: false,
      env: ENV,
      createProvider: async () => provider,
      localVm: {
        desktop: createDesktop,
        analysisRefusal: () => undefined,
        signal: controller.signal,
      },
      deps: { ...seams(), runSession },
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const shared = onlyDeps(participantDeps());
    expect(keysOf(shared)).toEqual(
      [...SHARED_KEYS, "appUrl", "createDesktop", "createProvider", "signalReady"]
        .filter((key) => key !== "prepareDesktop")
        .sort(),
    );
    expect(shared.createDesktop).toBe(createDesktop);
    expect(shared.brain).toEqual({ kind: "caller" });
    expect(sessions.map((session) => session.provider)).toEqual([provider, provider]);
    expect(sessions.map((session) => session.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });

  it("a caller's executor in process", async () => {
    const { sessions, runSession } = recordingSessions();
    const executor = fakeExecutor();
    const provider = doneProvider("caller-provider");
    const result = await runComputerUse({
      cwd,
      config: computerUseStudy(OPENAI, {
        participants: [{ id: "first", persona: "first-time-visitor" }],
      }),
      dryRun: false,
      env: ENV,
      createProvider: async () => provider,
      inProcess: { executor: async () => executor },
      deps: { ...seams(), runSession },
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const shared = onlyDeps(participantDeps());
    expect(keysOf(shared)).toEqual(
      [...SHARED_KEYS, "appUrl", "createDesktop", "createProvider", "inProcessExecutor"]
        .filter((key) => key !== "prepareDesktop")
        .sort(),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.provider).toBe(provider);
    expect(sessions[0]!.executor).toBe(executor);
  });
});

describe("shared world hands each participant the run's deps", () => {
  it("an openai brain on the provisioned plane: the shared app, one run budget and the seams", async () => {
    const { sessions, runSession } = recordingSessions(2);
    const deps = { ...seams(), runSession };
    const prepareDesktop = async () => undefined;
    const result = await runSharedWorld({
      cwd,
      config: provisionedStudy(OPENAI, { caps: { maxUsd: 1, maxTotalUsd: 2 } }),
      dryRun: false,
      env: ENV,
      prepareDesktop,
      deps,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const byId = participantDeps();
    expect([...byId.keys()].sort()).toEqual(["persona-01", "persona-02"]);
    const shared = onlyDeps(byId);
    expect(keysOf(shared)).toEqual(
      [...SHARED_KEYS, "appUrl", "runBudget", "screenMismatchPolicy"].sort(),
    );
    expect(shared.brain).toEqual({ kind: "openai", model: expect.any(String) });
    expect(shared.openaiApiKey).toBe(ENV.OPENAI_API_KEY);
    expect(shared.e2bApiKey).toBe(ENV.E2B_API_KEY);
    expect(shared.caps).toEqual({ maxUsd: 1, maxTotalUsd: 2 });
    expect(shared.runBudget?.maxTotalUsd).toBe(2);
    // Participants open the one served app; no subject env reaches their sandboxes.
    expect(shared.subject).toEqual({ kind: "shared-app", serveUrl: "http://127.0.0.1:3000/" });
    expect(shared.screenMismatchPolicy).toBe("record-evidence");
    expect(shared.studyId).toBe("desktop-deps-shared-world");
    expect(shared.participantCount).toBe(2);
    expect(shared.timeoutMs).toBe(60_000);
    // The 1-minute session plus the 10-minute teardown buffer.
    expect(shared.sandboxMs).toBe(11 * 60_000);
    expect(shared.requestTimeoutMs).toBe(e2bRequestTimeoutMs(ENV));
    // The physical project root, bound before the run starts.
    expect(shared.studyCwd).toBe(await realpath(cwd));
    expect(shared.redactScreenshots).toBe(false);
    expect(shared.reportSubjectPhase).toBe(defaultSubjectPhaseSink);
    expect(shared.scrubKnownValues(`url ${ENV.DATABASE_URL}`)).not.toContain(ENV.DATABASE_URL);
    expect(shared.now).toBe(deps.now);
    expect(shared.desktopModule).toBe(deps.desktopModule);
    expect(shared.detachedTimers).toBe(deps.detachedTimers);
    expect(shared.prepareDesktop).toBe(prepareDesktop);
    expect(new Set([...byId.values()].map((each) => each.appUrl)).size).toBe(1);

    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.provider).toBeUndefined();
      expect(session.openai?.apiKey).toBe(ENV.OPENAI_API_KEY);
      expect(session.maxUsd).toBe(1);
      expect(session.overRunBudget).toBeDefined();
    }
  });

  it("no run budget without caps.maxTotalUsd", async () => {
    const { runSession } = recordingSessions(2);
    await runSharedWorld({
      cwd,
      config: provisionedStudy(OPENAI),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession },
    });
    const shared = onlyDeps(participantDeps());
    expect(shared.runBudget).toBeUndefined();
    expect(keysOf(shared)).toEqual(
      [...SHARED_KEYS, "appUrl", "screenMismatchPolicy"]
        .filter((key) => key !== "prepareDesktop")
        .sort(),
    );
  });

  it.each([
    { actor: CODEX, agent: "codex", provider: "codex-participant" },
    { actor: CLAUDE, agent: "claude", provider: "claude-session" },
  ])(
    "a $agent local agent drives each participant, with no OpenAI key",
    async ({ actor, agent, provider }) => {
      const { sessions, runSession } = recordingSessions(2);
      const result = await runSharedWorld({
        cwd,
        config: provisionedStudy(actor),
        dryRun: false,
        env: { E2B_API_KEY: ENV.E2B_API_KEY, DATABASE_URL: ENV.DATABASE_URL },
        deps: { ...seams(), runSession },
      });
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      const shared = onlyDeps(participantDeps());
      expect(shared.brain).toEqual({ kind: "local-agent", agent });
      expect(shared.openaiApiKey).toBe("");
      expect(sessions.map((session) => session.provider?.id)).toEqual([provider, provider]);
    },
  );

  it("the external-public plane scrubs the host's lobby code from every participant", async () => {
    observedUrl = LOBBY_URL;
    const { sessions, runSession } = recordingSessions(2);
    const result = await runSharedWorld({
      cwd,
      config: externalPublicStudy(),
      dryRun: false,
      env: ENV,
      deps: { ...seams(), runSession },
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const byId = participantDeps();
    expect(keysOf(byId.get("host")!)).toEqual(
      [
        ...SHARED_KEYS,
        "appUrl",
        "onMessage",
        "onObservedUrl",
        "onScreenshot",
        "screenMismatchPolicy",
      ]
        .filter((key) => key !== "prepareDesktop")
        .sort(),
    );
    const shared = onlyDeps(byId);
    expect(shared.subject).toEqual({ kind: "shared-app" });
    expect(shared.scrubKnownValues("lobby AB2CD9")).not.toContain("AB2CD9");
    expect(sessions).toHaveLength(2);
  });
});
