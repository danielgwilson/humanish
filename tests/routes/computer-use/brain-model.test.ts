// The model a computer-use participant runs with, through each brain. The declared actors[0].model
// reaches each provider the way it does today: absent stays absent, and "" stays "". The cap
// estimator and the live-flush label fall back to the default model only when no model was
// declared. These run through the route, so they hold while the route moves its model reads from
// the config to the plan's brain.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorTokenUsage } from "../../../src/actors/contract.js";
import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaExecutor, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import {
  DEFAULT_OPENAI_CU_MODEL,
  OPENAI_RESPONSES_CU_CAPABILITIES,
} from "../../../src/actors/computer-use/openai-provider.js";
import { createRestrictedCodexParticipant } from "../../../src/actors/codex/restricted-participant.js";
import { startClaudeSession } from "../../../src/actors/local-agent/claude-session.js";
import { createLocalAgentProvider } from "../../../src/actors/local-agent/cli.js";
import type { Brain, ComputerUsePlan } from "../../../src/lab/plan-types.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../../src/lab/types.js";
import { startLiveTraceFlush } from "../../../src/routes/computer-use/live-flush.js";
import type { ParticipantDesktop } from "../../../src/routes/computer-use/participant-desktop.js";
import { planComputerUseLab } from "../../../src/routes/computer-use/plan.js";
import { runComputerUsePlan, runCuaActorLab } from "../../../src/routes/computer-use/route.js";
import type {
  CuaActorLabHooks,
  RunCuaActorLabOptions,
} from "../../../src/routes/computer-use/types.js";
import { estimateActorCostForExecution } from "../../../src/run/pricing.js";
import { ownDesktopAllocation } from "../../../src/substrates/desktop-session.js";

vi.mock("../../../src/actors/codex/restricted-participant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/codex/restricted-participant.js")>()),
  createRestrictedCodexParticipant: vi.fn(),
}));
vi.mock("../../../src/actors/local-agent/claude-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/local-agent/claude-session.js")>()),
  startClaudeSession: vi.fn(),
}));
vi.mock("../../../src/actors/local-agent/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/local-agent/cli.js")>()),
  createLocalAgentProvider: vi.fn(),
}));
// The local CLIs are not installed here; their readiness is tested on its own.
vi.mock("../../../src/actors/local-agent/readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/local-agent/readiness.js")>()),
  localAgentRefusal: vi.fn(async () => undefined),
}));
vi.mock("../../../src/routes/computer-use/live-flush.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/routes/computer-use/live-flush.js")>();
  return { ...actual, startLiveTraceFlush: vi.fn(actual.startLiveTraceFlush) };
});

const NON_DEFAULT_MODEL = "gpt-5.5";
const USAGE: ActorTokenUsage = { input: 10_000, output: 1_000 };

/** The declared actors[0].model values: undeclared, empty, the default named, and another. */
const DECLARED: readonly (string | undefined)[] = [
  undefined,
  "",
  DEFAULT_OPENAI_CU_MODEL,
  NON_DEFAULT_MODEL,
];
const label = (model: string | undefined) => (model === undefined ? "undeclared" : `"${model}"`);

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-brain-model-"));
  vi.mocked(startLiveTraceFlush).mockClear();
  for (const factory of [
    createRestrictedCodexParticipant,
    startClaudeSession,
    createLocalAgentProvider,
  ])
    vi.mocked(factory).mockReset();
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

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
    observe: async () => ({
      screenshot,
      stateSignature: "page",
      text: "Notes",
      url: "http://127.0.0.1:3000/",
    }),
    execute: async () => undefined,
  };
}

/** A local study desktop, so no E2B key or SDK is needed. */
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
    snapshot: () => ({
      released,
      streamUrlPresent: false,
      stateStepRecords: [],
      phaseRecords: [],
    }),
  };
}

/** A direct-library config: unparsed, so it can declare model "". */
function labConfig(args: {
  actor: Record<string, unknown>;
  model: string | undefined;
  maxUsd?: number;
}): LabConfig {
  return {
    schema: LAB_CONFIG_SCHEMA,
    id: "brain-model",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [
      {
        persona: "first-time-visitor",
        mission: "Save a note.",
        ...args.actor,
        ...(args.model === undefined ? {} : { model: args.model }),
      },
    ],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      ...(args.maxUsd === undefined ? {} : { caps: { maxUsd: args.maxUsd } }),
    },
    scenario: { mode: "live" },
    review: { analysis: false },
  } as LabConfig;
}

const OPENAI_ACTOR = { type: "openai-computer-use" };
const CODEX_ACTOR = { type: "local-agent", localAgent: "codex" };
const CLAUDE_ACTOR = { type: "local-agent", localAgent: "claude" };

/** The lab on the local target, whose desktop the test supplies as the local study's. */
function onLocalDesktop(config: LabConfig): LabConfig {
  return { ...config, execution: { ...config.execution, target: "local" } };
}

const fakeLocalVm = () => ({ desktop: () => fakeDesktop(), analysisRefusal: () => undefined });

/** Runs one live participant and returns what its session and the live flush received. */
async function run(
  config: LabConfig,
  hooks: CuaActorLabHooks = {},
  {
    localDesktop = true,
    ...driving
  }: { localDesktop?: boolean } & Pick<RunCuaActorLabOptions, "createProvider" | "inProcess"> = {},
) {
  const sessions: CuaActorSessionOptions[] = [];
  const result = await runCuaActorLab({
    cwd,
    config: localDesktop ? onLocalDesktop(config) : config,
    dryRun: false,
    ...driving,
    ...(localDesktop ? { localVm: fakeLocalVm() } : {}),
    hooks: {
      env: { OPENAI_API_KEY: "synthetic-openai-key" },
      runSession: async (options) => {
        sessions.push(options);
        return runCuaActorSession({
          ...options,
          provider: options.provider ?? doneProvider("synthetic-openai"),
        });
      },
      ...hooks,
    },
  });
  const flushModels = vi.mocked(startLiveTraceFlush).mock.calls.map(([args]) => args.model);
  return { result, sessions, flushModels };
}

/** The price the cap estimator puts on USAGE, against the price under `model`. */
function expectPricedAt(session: CuaActorSessionOptions, model: string) {
  expect(session.estimateTurnCostUsd).toBeDefined();
  expect(session.estimateTurnCostUsd!(USAGE)).toBe(
    estimateActorCostForExecution(USAGE, model).estimatedCostUsd,
  );
}

describe("computer-use participant model fixtures", () => {
  it("prices the two models the matrix tells apart differently", () => {
    expect(estimateActorCostForExecution(USAGE, DEFAULT_OPENAI_CU_MODEL).estimatedCostUsd).not.toBe(
      estimateActorCostForExecution(USAGE, NON_DEFAULT_MODEL).estimatedCostUsd,
    );
  });
});

describe("computer-use participant model, openai brain", () => {
  it.each(DECLARED.map((model) => ({ model, name: label(model) })))(
    "gives the session a model only when one is declared non-empty: $name",
    async ({ model }) => {
      const { result, sessions, flushModels } = await run(
        labConfig({ actor: OPENAI_ACTOR, model }),
      );
      expect(result.ok).toBe(true);
      expect(sessions).toHaveLength(1);
      const openai = sessions[0]!.openai!;
      if (model) expect(openai.model).toBe(model);
      else expect("model" in openai).toBe(false);
      expect(flushModels).toEqual([model ?? DEFAULT_OPENAI_CU_MODEL]);
    },
  );

  it.each(
    [undefined, DEFAULT_OPENAI_CU_MODEL, NON_DEFAULT_MODEL].map((model) => ({
      model,
      name: label(model),
    })),
  )("prices a capped turn at the declared model, else the default: $name", async ({ model }) => {
    const { result, sessions } = await run(labConfig({ actor: OPENAI_ACTOR, model, maxUsd: 5 }));
    expect(result.ok).toBe(true);
    expectPricedAt(sessions[0]!, model ?? DEFAULT_OPENAI_CU_MODEL);
  });

  it("refuses a cap on a declared empty model as unpriced, naming it", async () => {
    const { result, sessions } = await run(
      labConfig({ actor: OPENAI_ACTOR, model: "", maxUsd: 5 }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_UNPRICED_CAP");
    expect(result.error?.message).toContain('no rate for model ""');
    expect(sessions).toHaveLength(0);
  });
});

describe("computer-use participant model, caller brain", () => {
  it.each([undefined, NON_DEFAULT_MODEL].map((model) => ({ model, name: label(model) })))(
    "keeps the caller's provider and prices at the declared model, else the default, on a local study desktop: $name",
    async ({ model }) => {
      const provider = doneProvider("caller-provider");
      const { result, sessions, flushModels } = await run(
        labConfig({ actor: OPENAI_ACTOR, model, maxUsd: 5 }),
        {},
        { createProvider: async () => provider },
      );
      expect(result.ok).toBe(true);
      expect(sessions[0]!.provider).toBe(provider);
      if (model) expect(sessions[0]!.openai!.model).toBe(model);
      else expect("model" in sessions[0]!.openai!).toBe(false);
      expectPricedAt(sessions[0]!, model ?? DEFAULT_OPENAI_CU_MODEL);
      expect(flushModels).toEqual([model ?? DEFAULT_OPENAI_CU_MODEL]);
    },
  );

  it.each([undefined, NON_DEFAULT_MODEL].map((model) => ({ model, name: label(model) })))(
    "carries the declared model in process: $name",
    async ({ model }) => {
      const provider = doneProvider("caller-provider");
      const { result, sessions } = await run(
        labConfig({ actor: OPENAI_ACTOR, model, maxUsd: 5 }),
        {},
        {
          localDesktop: false,
          createProvider: async () => provider,
          inProcess: { executor: async () => fakeExecutor() },
        },
      );
      expect(result.ok).toBe(true);
      expect(sessions[0]!.provider).toBe(provider);
      if (model) expect(sessions[0]!.openai!.model).toBe(model);
      else expect("model" in sessions[0]!.openai!).toBe(false);
      expectPricedAt(sessions[0]!, model ?? DEFAULT_OPENAI_CU_MODEL);
    },
  );
});

describe("computer-use participant model, local-agent brain", () => {
  it.each(DECLARED.map((model) => ({ model, name: label(model) })))(
    "passes hosted Codex the declared model, including empty: $name",
    async ({ model }) => {
      vi.mocked(createRestrictedCodexParticipant).mockReturnValue({
        provider: doneProvider("restricted-codex-participant"),
        close: async () => ({ status: "confirmed" as const }),
      } as unknown as ReturnType<typeof createRestrictedCodexParticipant>);
      const { result, flushModels } = await run(labConfig({ actor: CODEX_ACTOR, model }));
      expect(result.ok).toBe(true);
      const options = vi.mocked(createRestrictedCodexParticipant).mock.calls[0]![0]!;
      if (model === undefined) expect("model" in options).toBe(false);
      else expect(options.model).toBe(model);
      expect(flushModels).toEqual([model ?? DEFAULT_OPENAI_CU_MODEL]);
    },
  );

  it.each(DECLARED.map((model) => ({ model, name: label(model) })))(
    "passes the Claude session the declared model, including empty: $name",
    async ({ model }) => {
      vi.mocked(startClaudeSession).mockResolvedValue({
        provider: doneProvider("claude-session"),
        close: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof startClaudeSession>>);
      const { result } = await run(labConfig({ actor: CLAUDE_ACTOR, model }));
      expect(result.ok).toBe(true);
      const [options] = vi.mocked(startClaudeSession).mock.calls[0]!;
      if (model === undefined) expect("model" in (options ?? {})).toBe(false);
      else expect(options?.model).toBe(model);
    },
  );

  it.each(DECLARED.map((model) => ({ model, name: label(model) })))(
    "passes the one-shot Claude provider the declared model, including empty: $name",
    async ({ model }) => {
      vi.mocked(createLocalAgentProvider).mockReturnValue(doneProvider("claude-one-shot"));
      const { result } = await run(labConfig({ actor: CLAUDE_ACTOR, model }), {
        env: { OPENAI_API_KEY: "synthetic-openai-key", HUMANISH_LOCAL_AGENT_ONE_SHOT: "1" },
      });
      expect(result.ok).toBe(true);
      const [options] = vi.mocked(createLocalAgentProvider).mock.calls[0]!;
      expect(options.agent).toBe("claude");
      if (model === undefined) expect("model" in options).toBe(false);
      else expect(options.model).toBe(model);
    },
  );
});

describe("computer-use participant model, the plan's brain, over the config", () => {
  /** Plans `config`, swaps in `brain`, and runs that plan with the same config and hooks. */
  async function runWithBrain(declared: LabConfig, brain: Brain, hooks: CuaActorLabHooks) {
    const config = onLocalDesktop(declared);
    const planned = planComputerUseLab(config, { dryRun: false, hooks });
    if (!planned.ok) throw new Error(planned.refusal.message);
    const plan: ComputerUsePlan = {
      ...planned.plan,
      runner: { ...planned.plan.runner, brain } as ComputerUsePlan["runner"],
    };
    return runComputerUsePlan(plan, { cwd, hooks, localVm: fakeLocalVm() }, config);
  }

  it("gives the session, the cap estimator and the flush label the plan's declared model", async () => {
    const sessions: CuaActorSessionOptions[] = [];
    const result = await runWithBrain(
      labConfig({ actor: OPENAI_ACTOR, model: undefined, maxUsd: 5 }),
      { kind: "openai", model: NON_DEFAULT_MODEL, declaredModel: NON_DEFAULT_MODEL },
      {
        env: { OPENAI_API_KEY: "synthetic-openai-key" },
        runSession: async (options) => {
          sessions.push(options);
          return runCuaActorSession({ ...options, provider: doneProvider("synthetic-openai") });
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(sessions[0]!.openai!.model).toBe(NON_DEFAULT_MODEL);
    expectPricedAt(sessions[0]!, NON_DEFAULT_MODEL);
    expect(vi.mocked(startLiveTraceFlush).mock.calls.map(([args]) => args.model)).toEqual([
      NON_DEFAULT_MODEL,
    ]);
  });

  it("starts the plan's local agent with the plan's declared model", async () => {
    vi.mocked(startClaudeSession).mockResolvedValue({
      provider: doneProvider("claude-session"),
      close: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof startClaudeSession>>);
    const result = await runWithBrain(
      labConfig({ actor: CODEX_ACTOR, model: undefined }),
      { kind: "local-agent", agent: "claude", declaredModel: "synthetic-claude-model" },
      {
        env: {},
        runSession: async (options) => runCuaActorSession(options),
      },
    );
    expect(result.ok).toBe(true);
    expect(createRestrictedCodexParticipant).not.toHaveBeenCalled();
    expect(vi.mocked(startClaudeSession).mock.calls[0]![0]?.model).toBe("synthetic-claude-model");
  });

  it("gives hosted Codex the plan's declared model", async () => {
    vi.mocked(createRestrictedCodexParticipant).mockReturnValue({
      provider: doneProvider("restricted-codex-participant"),
      close: async () => ({ status: "confirmed" as const }),
    } as unknown as ReturnType<typeof createRestrictedCodexParticipant>);
    const result = await runWithBrain(
      labConfig({ actor: CODEX_ACTOR, model: undefined }),
      { kind: "local-agent", agent: "codex", declaredModel: "synthetic-codex-model" },
      {
        env: {},
        runSession: async (options) => runCuaActorSession(options),
      },
    );
    expect(result.ok).toBe(true);
    expect(vi.mocked(createRestrictedCodexParticipant).mock.calls[0]![0]?.model).toBe(
      "synthetic-codex-model",
    );
  });

  it("fails the run when hosted Codex reports a disallowed item after its last request", async () => {
    vi.mocked(createRestrictedCodexParticipant).mockReturnValue({
      provider: doneProvider("restricted-codex-participant"),
      close: async () => ({ status: "confirmed" as const, refusal: "codex_tool_call" as const }),
    } as unknown as ReturnType<typeof createRestrictedCodexParticipant>);
    const result = await runWithBrain(
      labConfig({ actor: CODEX_ACTOR, model: undefined }),
      { kind: "local-agent", agent: "codex", declaredModel: "synthetic-codex-model" },
      {
        env: {},
        createDesktopLane: () => fakeDesktop(),
        runSession: async (options) => runCuaActorSession(options),
      },
    );
    const message =
      "Codex reported a disallowed item after the participant's last request (codex_tool_call).";
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(message);
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "status.json"), "utf8"),
    ) as {
      outcome?: { ok?: boolean; execution?: { failures: { kind: string; message: string }[] } };
    };
    expect(status.outcome?.ok).toBe(false);
    expect(status.outcome?.execution?.failures).toEqual([
      { kind: "provider-policy", message: expect.stringContaining(message) },
    ]);
  });

  it("gives the one-shot Claude provider the plan's declared model", async () => {
    vi.mocked(createLocalAgentProvider).mockReturnValue(doneProvider("claude-one-shot"));
    const result = await runWithBrain(
      labConfig({ actor: CLAUDE_ACTOR, model: undefined }),
      { kind: "local-agent", agent: "claude", declaredModel: "synthetic-claude-model" },
      {
        env: { HUMANISH_LOCAL_AGENT_ONE_SHOT: "1" },
        runSession: async (options) => runCuaActorSession(options),
      },
    );
    expect(result.ok).toBe(true);
    expect(vi.mocked(createLocalAgentProvider).mock.calls[0]![0].model).toBe(
      "synthetic-claude-model",
    );
  });
});
