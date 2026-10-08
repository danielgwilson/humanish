// A computer-use run takes its lab id, desktop, subject env values and spend caps from its plan.
// Each case runs a plan whose field differs from the config it came from, and asserts the run used
// the plan's value.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaExecutor, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "../../../src/actors/computer-use/openai-provider.js";
import { parseStudy } from "../../../src/study/config.js";
import type { ComputerUsePlan } from "../../../src/study/plan-types.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import type { ParticipantDesktop } from "../../../src/routes/computer-use/participant-desktop.js";
import { planComputerUseStudy } from "../../../src/routes/computer-use/plan.js";
import { admitComputerUsePlan } from "../../../src/routes/computer-use/route.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import { provisionParticipantSubject } from "../../../src/routes/computer-use/e2b-desktop/prepare.js";
import {
  newParticipantState,
  type E2BParticipantContext,
} from "../../../src/routes/computer-use/e2b-desktop/state.js";
import type { CuaParticipantDeps } from "../../../src/routes/computer-use/types.js";
import { participantRun } from "../../helpers/participant-run.js";
import { ownDesktopAllocation } from "../../../src/substrates/desktop-session.js";
import { runAdmitted } from "../../helpers/route-run.js";
import { sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-residual-reads-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const KEYS = { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: "synthetic-e2b" };

function appUrlLab(): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "config-lab",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: {
      type: "openai-computer-use",
      persona: "first-time-visitor",
      mission: "Look and stop.",
    },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    review: { analysis: false },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function planOf(config: StudyConfig, deps: StudyDeps): ComputerUsePlan {
  const planned = planComputerUseStudy(config, {
    dryRun: false,
    hasRunSession: deps.runSession !== undefined,
    sandboxCeiling: sandboxCeiling({}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return planned.plan;
}

/** An E2B module whose create records its arguments, then stops the run before a desktop exists. */
function recordingModule() {
  const creates: unknown[][] = [];
  const module = {
    Sandbox: {
      create: async (...args: unknown[]) => {
        creates.push(args);
        throw new Error("synthetic allocation stop");
      },
      kill: async () => true,
    },
  } as unknown as E2BDesktopModule;
  return { module, creates };
}

/** The create call's options: the last argument; a custom template comes first. */
const optionsOf = (args: unknown[]) =>
  args[args.length - 1] as { metadata?: Record<string, string>; envs?: Record<string, string> };

async function runAndCapture(plan: ComputerUsePlan, config: StudyConfig, deps: StudyDeps) {
  await runAdmitted(admitComputerUsePlan(plan, { cwd, env: KEYS, deps }, config)).catch(
    () => undefined,
  );
}

describe("computer-use run reads the plan's residual fields", () => {
  it("names the plan's lab id in the sandbox metadata", async () => {
    const config = appUrlLab();
    const { module, creates } = recordingModule();
    const deps: StudyDeps = { desktopModule: async () => module };
    const plan = { ...planOf(config, deps), studyId: "plan-lab" };
    await runAndCapture(plan, config, deps);
    expect(creates).toHaveLength(1);
    expect(optionsOf(creates[0]!).metadata?.labId).toBe("plan-lab");
  });

  it("creates the desktop from the plan's template and with its subject env values", async () => {
    const config = appUrlLab();
    const { module, creates } = recordingModule();
    const deps: StudyDeps = { desktopModule: async () => module };
    const planned = planOf(config, deps);
    const plan: ComputerUsePlan = {
      ...planned,
      residual: {
        ...planned.residual,
        execution: { target: "e2b-desktop", desktop: { template: "plan-template" } },
        subject: { ...planned.residual.subject, envValues: { PLAN_ONLY: "plan-value" } },
      },
    };
    await runAndCapture(plan, config, deps);
    expect(creates).toHaveLength(1);
    expect(creates[0]![0]).toBe("plan-template");
    expect(optionsOf(creates[0]!).envs).toEqual({ PLAN_ONLY: "plan-value" });
  });

  it("injects the plan's fake-email catch env into a clone's sandbox", async () => {
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "config-lab",
      route: "computer-use",
      mode: "live",
      subject: {
        source: "clone",
        repos: ["example-org/example-app"],
        serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
      },
      actor: {
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Look and stop.",
      },
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      review: { analysis: false },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const { module, creates } = recordingModule();
    const deps: StudyDeps = { desktopModule: async () => module };
    const planned = planOf(parsed.config, deps);
    const plan: ComputerUsePlan = {
      ...planned,
      residual: {
        ...planned.residual,
        comms: { email: { kind: "fake", injectEnv: "PLAN_CATCH_URL" } },
      } as ComputerUsePlan["residual"],
    };
    await runAndCapture(plan, parsed.config, deps);
    expect(creates).toHaveLength(1);
    expect(Object.keys(optionsOf(creates[0]!).envs ?? {})).toContain("PLAN_CATCH_URL");
  });

  it("warns about the plan's per-participant cap on a fan-out", async () => {
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "config-lab",
      route: "computer-use",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: {
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Look and stop.",
      },
      participants: [{ id: "a" }, { id: "b" }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      review: { analysis: false },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const planned = planComputerUseStudy(parsed.config, {
      dryRun: true,
      sandboxCeiling: sandboxCeiling({}),
    });
    if (!planned.ok) throw new Error(planned.refusal.message);
    const plan = { ...planned.plan, caps: { maxUsd: 4 } };
    const result = await runAdmitted(admitComputerUsePlan(plan, { cwd }, parsed.config));
    expect(result.warnings.join("\n")).toContain("caps.maxUsd ($4) caps each participant");
  });

  it("caps each participant's spend at the plan's maxUsd", async () => {
    // The test supplies the desktop as a local study's, on the local target.
    const declared = appUrlLab();
    const config: StudyConfig = {
      ...declared,
      execution: { ...declared.execution, target: "local" },
    };
    const sessions: CuaActorSessionOptions[] = [];
    const provider: CuaProvider = {
      id: "synthetic-provider",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "Done.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
    };
    const deps: StudyDeps = {
      runSession: async (options) => {
        sessions.push(options);
        return runCuaActorSession({ ...options, provider });
      },
    };
    const plan = { ...planOf(config, deps), caps: { maxUsd: 3 } };
    const localVm = { desktop: () => fakeDesktop(), analysisRefusal: () => undefined };
    const result = await runAdmitted(
      admitComputerUsePlan(plan, { cwd, env: KEYS, deps, localVm }, config),
    );
    expect(result.ok).toBe(true);
    expect(sessions[0]?.maxUsd).toBe(3);
  });
});

describe("a participant's subject provisioning reads the plan", () => {
  /** Provisions `deps`' subject on a fake desktop that stops at the first script naming `stop`. */
  async function provisionScripts(deps: Record<string, unknown>, stop: string): Promise<string[]> {
    const scripts: string[] = [];
    const record = (text: string) => {
      scripts.push(text);
      if (text.includes(stop)) throw new Error(`stop at ${stop}`);
    };
    const desktop = {
      commands: {
        run: async (command: string) => {
          record(command);
          // Each step's status file reads 0, so the step completes at once.
          return { exitCode: 0, stdout: command.includes("/status") ? "0" : "" };
        },
      },
      files: {
        write: async (_path: string, data: string) => {
          record(String(data));
        },
      },
    } as unknown as E2BDesktopSandbox;
    const spec = participantRun({
      id: "participant-a",
      index: 0,
      persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "synthetic" },
      instructions: "Look and stop.",
    });
    const ctx: E2BParticipantContext = {
      spec,
      deps: {
        requestTimeoutMs: 1_000,
        scrubKnownValues: (text: string) => text,
        ...deps,
      } as unknown as CuaParticipantDeps,
      warnings: [],
      targetUrl: "http://127.0.0.1:3000/",
      desktopCliRoute: (deps.subject as { kind: string }).kind === "desktop-cli",
      comms: undefined,
      onSubjectPhase: () => undefined,
    };
    await provisionParticipantSubject(ctx, newParticipantState(spec), desktop).catch(() => {});
    return scripts;
  }

  it("clones at the plan's residual depth, not the config's", async () => {
    const scripts = await provisionScripts(
      {
        config: { subject: { clone: { depth: 2 } } },
        residual: { subject: { clone: { depth: 7 } } },
        subject: {
          kind: "clone",
          repo: "example-org/example-app",
          serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
          env: [],
        },
      },
      "git clone",
    );
    expect(scripts.find((text) => text.includes("git clone"))).toContain("--depth 7");
  });

  it("installs the plan's desktop-cli product, not the config's", async () => {
    const scripts = await provisionScripts(
      {
        config: { subject: { product: { name: "config-cli", install: "npm i -g config-cli" } } },
        residual: { subject: {} },
        subject: {
          kind: "desktop-cli",
          product: { name: "plan-cli", install: "npm i -g plan-cli" },
        },
      },
      "npm i -g",
    );
    const install = scripts.find((text) => text.includes("npm i -g"));
    expect(install).toContain("plan-cli");
    expect(install).not.toContain("config-cli");
  });
});

function fakeDesktop(): ParticipantDesktop {
  const screenshot = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const executor: CuaExecutor = {
    observe: async () => ({ screenshot, stateSignature: "page", text: "Page", url: "" }),
    execute: async () => undefined,
  };
  const allocation = ownDesktopAllocation({
    resourceId: "synthetic-desktop",
    release: vi.fn(async () => ({ status: "released" as const, reason: "terminated" as const })),
  });
  let released = false;
  return {
    prepare: async () => undefined,
    openSession: async () => ({ executor: allocation.open(executor).executor }),
    finalize: async () => {
      released = (await allocation.close()).status === "released";
    },
    snapshot: () => ({ released, streamUrlPresent: false, stateStepRecords: [], phaseRecords: [] }),
  };
}
