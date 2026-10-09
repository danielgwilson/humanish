// What every route planner shares: the plan fields common to all routes, the frozen residual config,
// and the requirement and subject helpers.

import { DEFAULT_OPENAI_CU_MODEL } from "../actors/computer-use/openai-provider.js";
import type {
  Brain,
  ComputerUsePlan,
  NonEmpty,
  PlannedAnalysis,
  ProvisionedSubject,
  Requirement,
  ResidualConfig,
} from "./plan-types.js";
import { analysisSkipFor } from "./automatic-analysis-plan.js";
import type { StudyConfig } from "./types.js";

export type Base = Omit<
  ComputerUsePlan,
  "route" | "actor" | "runner" | "concurrency" | "sessionBudgetMs" | "sandboxMs" | "caps" | "rerun"
>;

// A YAML alias can make a parsed record contain itself (an inline persona that names its own
// anchor), and structuredClone keeps the cycle, so each object is frozen once.
function deepFreeze<T>(value: T, frozen = new WeakSet<object>()): T {
  if (typeof value === "object" && value !== null && !frozen.has(value)) {
    frozen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, frozen);
    Object.freeze(value);
  }
  return value;
}

function residualOf(config: StudyConfig): Readonly<ResidualConfig> {
  const { comms, policies, defaults, review } = config;
  return deepFreeze(
    structuredClone({
      ...(comms === undefined ? {} : { comms }),
      ...(policies === undefined ? {} : { policies }),
      ...(defaults === undefined ? {} : { defaults }),
      ...(review === undefined ? {} : { review }),
      ...(config.execution?.desktop === undefined && config.execution?.target === undefined
        ? {}
        : {
            execution: {
              ...(config.execution?.desktop === undefined
                ? {}
                : { desktop: config.execution.desktop }),
              ...(config.execution?.target === undefined
                ? {}
                : { target: config.execution.target }),
            },
          }),
      subject: {
        ...(config.subject.clone === undefined ? {} : { clone: config.subject.clone }),
        ...(config.subject.localTree === undefined ? {} : { localTree: config.subject.localTree }),
        ...(config.subject.repos === undefined ? {} : { repos: config.subject.repos }),
        ...(config.subject.envValues === undefined ? {} : { envValues: config.subject.envValues }),
      },
    }),
  );
}

export function isNonEmpty<T>(values: readonly T[]): values is NonEmpty<T> {
  return values.length > 0;
}

export function planCaps(config: StudyConfig): ComputerUsePlan["caps"] {
  const caps = config.caps;
  return {
    ...(caps?.maxUsd === undefined ? {} : { maxUsd: caps.maxUsd }),
    ...(caps?.maxTotalUsd === undefined ? {} : { maxTotalUsd: caps.maxTotalUsd }),
  };
}

export function provisionedSubject(config: StudyConfig): ProvisionedSubject | undefined {
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
  config: StudyConfig,
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

export function brainOf(config: StudyConfig, callerProvider: boolean): Brain {
  const actor = config.actor;
  if (callerProvider) return callerBrainOf(config);
  const declared = declaredModelOf(config);
  if (actor?.type === "local-agent")
    return { kind: "local-agent", agent: actor.localAgent ?? "codex", ...declared };
  return { kind: "openai", model: actor?.model ?? DEFAULT_OPENAI_CU_MODEL, ...declared };
}

/** The brain of a run whose provider the library caller supplies. */
export function callerBrainOf(config: StudyConfig): Extract<Brain, { kind: "caller" }> {
  return { kind: "caller", ...declaredModelOf(config) };
}

function declaredModelOf(config: StudyConfig): { declaredModel?: string } {
  const model = config.actor?.model;
  return model === undefined ? {} : { declaredModel: model };
}

/** The model a participant's spend is priced at when its provider reports none. */
export function pricedModel(brain: Brain): string {
  return brain.declaredModel ?? DEFAULT_OPENAI_CU_MODEL;
}

/** The fields every plan shares, from a config whose analysis already resolved. */
export function planBase(
  config: StudyConfig,
  input: {
    readonly dryRun: boolean;
    readonly analysis?: {
      readonly config?: PlannedAnalysis["config"] | undefined;
      readonly preferLargerOutput?: boolean | undefined;
    };
    /** How many participants the run has, which decides whether its analysis can run. */
    readonly participants?: number;
  },
): Base {
  const analysis = input.analysis?.config;
  const skip = analysisSkipFor(input.participants ?? 1);
  return {
    studyId: config.id,
    ...(config.title === undefined ? {} : { title: config.title }),
    residual: residualOf(config),
    dryRun: input.dryRun,
    ...(analysis === undefined
      ? {}
      : {
          analysis: {
            config: analysis,
            trigger: config.review?.analysis === undefined ? "default" : "explicit",
            preferLargerOutput: input.analysis?.preferLargerOutput === true,
            ...(skip === undefined ? {} : { skip }),
          },
        }),
    requirements: [],
  };
}
