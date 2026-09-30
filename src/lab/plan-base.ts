// What every route planner shares: the plan fields common to all routes, the frozen residual config,
// and the requirement and subject helpers.

import { DEFAULT_OPENAI_CU_MODEL } from "../actors/computer-use/openai-provider.js";
import type { RunLabProvenance } from "../run/status.js";
import type {
  Brain,
  ComputerUsePlan,
  LabPlan,
  NonEmpty,
  PlanGap,
  PlannedAnalysis,
  ProvisionedSubject,
  Requirement,
  ResidualConfig,
} from "./plan-types.js";
import type { LabConfig } from "./types.js";

export type Base = Omit<
  ComputerUsePlan,
  "route" | "actor" | "runner" | "concurrency" | "sessionBudgetMs" | "sandboxMs" | "caps" | "rerun"
>;
export type Built<P extends LabPlan> = P | PlanGap;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function residualOf(config: LabConfig): Readonly<ResidualConfig> {
  const { comms, policies, personas, defaults, review } = config;
  return deepFreeze(
    structuredClone({
      ...(comms === undefined ? {} : { comms }),
      ...(policies === undefined ? {} : { policies }),
      ...(personas === undefined ? {} : { personas }),
      ...(defaults === undefined ? {} : { defaults }),
      ...(review === undefined ? {} : { review }),
      ...(config.execution?.desktop === undefined
        ? {}
        : { execution: { desktop: config.execution.desktop } }),
      subject: {
        ...(config.subject.clone === undefined ? {} : { clone: config.subject.clone }),
        ...(config.subject.localTree === undefined ? {} : { localTree: config.subject.localTree }),
        ...(config.subject.repos === undefined ? {} : { repos: config.subject.repos }),
      },
    }),
  );
}

export function isNonEmpty<T>(values: readonly T[]): values is NonEmpty<T> {
  return values.length > 0;
}

export function capsOf(config: LabConfig): ComputerUsePlan["caps"] {
  const caps = config.execution?.caps;
  return {
    ...(caps?.maxUsd === undefined ? {} : { maxUsd: caps.maxUsd }),
    ...(caps?.maxTotalUsd === undefined ? {} : { maxTotalUsd: caps.maxTotalUsd }),
  };
}

export function provisionedSubject(config: LabConfig): ProvisionedSubject | undefined {
  const { serve, state } = config.subject;
  const env = config.subject.env ?? [];
  if (serve === undefined) return undefined;
  const withState = state === undefined ? {} : { state };
  if (config.subject.source === "local-tree")
    return { kind: "local-tree", serve, env, ...withState };
  const repo = config.subject.repos?.[0];
  if (config.subject.source !== "clone" || repo === undefined) return undefined;
  return { kind: "clone", repo, serve, env, ...withState };
}

/** Keys, env and local tools a live run checks right before it acquires anything. */
export function desktopRequirements(
  config: LabConfig,
  args: { e2b: boolean; brain: Brain; localVm: boolean; externalCatch: boolean },
): Requirement[] {
  const requirements: Requirement[] = [];
  if (args.e2b) requirements.push({ kind: "key", name: "E2B_API_KEY" });
  if (args.localVm) requirements.push({ kind: "local-vm" });
  if (args.brain.kind === "openai") requirements.push({ kind: "key", name: "OPENAI_API_KEY" });
  if (args.brain.kind === "local-agent")
    requirements.push({ kind: "local-agent", agent: args.brain.agent });
  const env = config.subject.source === "clone" || config.subject.source === "local-tree";
  const names = env ? (config.subject.env ?? []) : [];
  if (isNonEmpty(names)) requirements.push({ kind: "subject-env", names });
  const email = config.comms?.email;
  if (args.externalCatch && email?.kind === "fake" && email.external !== undefined)
    requirements.push({ kind: "external-catch", url: email.external.catchBaseUrl });
  if (email?.kind === "real")
    requirements.push({ kind: "receiving-connection", connection: email.connection });
  return requirements;
}

export function brainOf(config: LabConfig, callerProvider: boolean): Brain {
  const actor = config.actors[0];
  if (callerProvider) return { kind: "caller" };
  if (actor?.type === "local-agent")
    return { kind: "local-agent", agent: actor.localAgent ?? "codex" };
  return { kind: "openai", model: actor?.model ?? DEFAULT_OPENAI_CU_MODEL };
}

/** The fields every plan shares, from a config whose analysis already resolved. */
export function planBase(
  config: LabConfig,
  input: {
    readonly dryRun: boolean;
    readonly lab?: RunLabProvenance;
    readonly analysis?: {
      readonly config?: PlannedAnalysis["config"] | undefined;
      readonly preferLargerOutput?: boolean | undefined;
    };
  },
): Base {
  const analysis = input.analysis?.config;
  return {
    labId: config.id,
    ...(input.lab === undefined ? {} : { lab: input.lab }),
    residual: residualOf(config),
    dryRun: input.dryRun,
    ...(analysis === undefined
      ? {}
      : {
          analysis: {
            config: analysis,
            trigger: config.review?.analysis === undefined ? "default" : "explicit",
            preferLargerOutput: input.analysis?.preferLargerOutput === true,
          },
        }),
    requirements: [],
  };
}
