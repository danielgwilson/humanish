// The route decision. A lab's route follows from its composition (subject.source,
// execution.target, the first actor's registered lane, subject.topology), never from a declared
// kind. This is the only function that decides it; selectLabBackend maps its answer to the older
// backend names.

import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../actors/computer-use/openai-provider.js";
import { browserSurfaces } from "../actors/scripted-browser/types.js";
import type { DwellWindow, StopWhen } from "../actors/stop-conditions.js";
import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import {
  defaultSessionTimeoutMs,
  resolveLaneDevice,
  resolvePerLaneSandboxMs,
} from "../routes/computer-use/lane-plan.js";
import { isLocalBrowserLab, localBrowserDefaults } from "../substrates/local/runtime-config.js";
import type { DevicePreset } from "./device-presets.js";
import type { LabBackend, RunLabOptions } from "./engine.js";
import type {
  AtLeastTwo,
  Brain,
  ComputerUsePlan,
  ComputerUseRunner,
  LabBindings,
  LabPlan,
  NonEmpty,
  PlanGap,
  PlanResult,
  PlannedAnalysis,
  ProvisionedSubject,
  Requirement,
  ResidualConfig,
  ScriptedPlan,
  SharedWorldPlane,
  SharedWorldPlan,
  TerminalPlan,
} from "./plan-types.js";
import {
  actorResolvesToComputerUse,
  MAX_CUA_LANES,
  participantIdAt,
  routesToComputerUse,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "./routing.js";
import type { LabTask } from "./tasks.js";
import type { LabActorLane, LabConfig } from "./types.js";

/** The five execution paths a lab can take. */
export type LabRoute = "preview" | "computer-use" | "shared-world" | "terminal" | "scripted";

const BACKENDS: Record<LabRoute, LabBackend> = {
  preview: "synthetic",
  "computer-use": "cua",
  "shared-world": "concurrent-shared-world",
  terminal: "terminal",
  scripted: "scripted",
};

/** The backend name older callers and wire fields use for a route. */
export function backendOf(route: LabRoute): LabBackend {
  return BACKENDS[route];
}

/**
 * The route a config takes. It never refuses: a config no route can run still gets the route
 * whose own checks refuse it with the most precise reason.
 */
export function routeOf(config: LabConfig): LabRoute {
  const source = config.subject.source;
  // A scripted-browser actor on a loopback app or a provisioned clone replays committed steps.
  if (routesToScriptedBrowser(config)) return "scripted";
  // A terminal-product subject goes to the terminal route even with an unregistered actor, so that
  // route refuses the actor instead of another route running something else.
  if (routesToTerminalProduct(config) || source === "terminal-product") return "terminal";
  // Checked before computer use: the same composition without the topology declaration runs as
  // independent lanes.
  if (routesToSharedWorld(config)) return "shared-world";
  // A CLI studied at a desktop is a computer-use study whose subject is a terminal window.
  if (source === "desktop-cli") return "computer-use";
  // Every other app-url, clone, local-app or local-tree config goes to computer use, including
  // ones with an unknown actor: that route refuses the actor, where the preview route would run
  // no participant at all.
  if (
    routesToComputerUse(config) ||
    source === "app-url" ||
    source === "clone" ||
    source === "local-app" ||
    source === "local-tree"
  )
    return "computer-use";
  // this-repo runs the synthetic preview.
  return "preview";
}

/** Who one participant is. Every route with participants carries this record. */
interface Participant {
  /** Declared roster id, else `lane-NN` (independent lanes) or `role-NN` (shared-world seats). */
  readonly id: string;
  /** 0-based position in the roster. Bundle `sim-NNN` and `stream-NNN` ids derive from it. */
  readonly index: number;
  /** `lanes[i].persona ?? actors[0].persona`. The route compiles the committed persona file. */
  readonly personaId: string | undefined;
  /** The declared mission and per-participant focus. An absent mission takes the route's default. */
  readonly assignment: { readonly mission?: string; readonly focus?: string };
  /** Taxonomy labels copied to the bundle and the plan table; they change no behavior. */
  readonly labels: {
    readonly actorType?: string;
    readonly surface?: string;
    readonly caseGroup?: string;
  };
}

/** A participant at a desktop: computer use and shared world. */
interface DesktopParticipant extends Participant {
  readonly device: {
    readonly name: string;
    readonly preset: DevicePreset;
    readonly resolution: readonly [number, number];
  };
  /** Lane value, else actor value, else absent (the provider default is recorded in the trace). */
  readonly limits: {
    readonly stopWhen?: StopWhen;
    readonly dwell?: DwellWindow;
    readonly reasoningEffort?: ReasoningEffort;
    readonly maxOutputTokens?: number;
  };
}

/** Only independent computer-use lanes consume a task protocol and a per-lane target. */
export interface ComputerUseParticipant extends DesktopParticipant {
  readonly tasks?: readonly LabTask[];
  /** app-url fan-out only: this lane's own entry URL; absent means the subject URL. */
  readonly targetUrl?: string;
}

/** A seat on a provisioned plane: an optional same-origin path under `serve.url`. */
export interface ProvisionedSeat extends DesktopParticipant {
  readonly entry?: string;
  // Fields of other participant kinds. `never` keeps them out even through a variable, where
  // TypeScript's excess-property check does not apply.
  readonly host?: never;
  readonly tasks?: never;
  readonly targetUrl?: never;
}

/** A seat on an external public plane: exactly one seat hosts the shared session. */
export interface ExternalPublicSeat extends DesktopParticipant {
  readonly host: boolean;
  readonly entry?: never;
  readonly tasks?: never;
  readonly targetUrl?: never;
}

export type SharedWorldSeats =
  | { readonly plane: "provisioned"; readonly seats: readonly ProvisionedSeat[] }
  | { readonly plane: "external-public"; readonly seats: readonly ExternalPublicSeat[] };

function desktopParticipant(
  config: LabConfig,
  lane: LabActorLane | undefined,
  index: number,
  kind: "lane" | "seat",
  focus: string | undefined,
): DesktopParticipant {
  const actor = config.actors[0];
  const device = resolveLaneDevice(config, lane);
  const personaId = lane?.persona ?? actor?.persona;
  const mission = actor?.mission;
  const stopWhen = lane?.stopWhen ?? actor?.stopWhen;
  const dwell = lane?.dwell ?? actor?.dwell;
  const reasoningEffort = lane?.reasoningEffort ?? actor?.reasoningEffort;
  const maxOutputTokens = actor?.maxOutputTokens;
  return {
    id: participantIdAt(index, lane?.id, kind),
    index,
    personaId,
    assignment: {
      ...(mission === undefined ? {} : { mission }),
      ...(focus === undefined ? {} : { focus }),
    },
    labels: {
      ...(lane?.actorType === undefined ? {} : { actorType: lane.actorType }),
      ...(lane?.surface === undefined ? {} : { surface: lane.surface }),
      ...(lane?.caseGroup === undefined ? {} : { caseGroup: lane.caseGroup }),
    },
    device: { name: device.name, preset: device.preset, resolution: device.resolution },
    limits: {
      ...(stopWhen === undefined ? {} : { stopWhen }),
      ...(dwell === undefined ? {} : { dwell }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  };
}

/**
 * The lanes of a computer-use lab: the declared roster, else `count` identical lanes. A count
 * override (`--count`) applies only when no roster is declared.
 */
export function computerUseParticipants(
  config: LabConfig,
  countOverride?: number,
): ComputerUseParticipant[] {
  const actor = config.actors[0];
  const roster = actor?.lanes;
  const count = roster ? roster.length : Math.max(1, countOverride ?? actor?.count ?? 1);
  return Array.from({ length: count }, (_, index) => {
    const lane = roster?.[index];
    const focus = roster ? lane?.instruction : actor?.laneFocus?.instruction;
    return {
      ...desktopParticipant(config, lane, index, "lane", focus),
      ...(actor?.tasks === undefined ? {} : { tasks: actor.tasks }),
      ...(lane?.target === undefined ? {} : { targetUrl: lane.target }),
    };
  });
}

/** The seats of a shared-world lab, one per roster entry, typed by the plane they share. */
export function sharedWorldSeats(config: LabConfig): SharedWorldSeats {
  const roster = config.actors[0]?.lanes ?? [];
  const seat = (lane: LabActorLane, index: number): DesktopParticipant =>
    desktopParticipant(config, lane, index, "seat", lane.instruction);
  if (config.subject.source === "app-url") {
    return {
      plane: "external-public",
      seats: roster.map((lane, index) => ({ ...seat(lane, index), host: lane.host === true })),
    };
  }
  return {
    plane: "provisioned",
    seats: roster.map((lane, index) => ({
      ...seat(lane, index),
      ...(lane.entry === undefined ? {} : { entry: lane.entry }),
    })),
  };
}

/** Resolve dry-run: explicit override wins, else the scenario mode, else the given fallback. */
export function resolveLabDryRun(
  config: LabConfig,
  override: boolean | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
  if (override !== undefined) {
    return override;
  }
  if (config.scenario?.mode === "live") {
    return false;
  }
  if (config.scenario?.mode === "dry-run") {
    return true;
  }
  return fallback;
}

type Base = Omit<
  ComputerUsePlan,
  "route" | "runner" | "concurrency" | "sessionBudgetMs" | "sandboxMs" | "caps" | "rerun"
>;
type Built<P extends LabPlan> = P | PlanGap;

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

function isNonEmpty<T>(values: readonly T[]): values is NonEmpty<T> {
  return values.length > 0;
}

function capsOf(config: LabConfig): ComputerUsePlan["caps"] {
  const caps = config.execution?.caps;
  return {
    ...(caps?.maxUsd === undefined ? {} : { maxUsd: caps.maxUsd }),
    ...(caps?.maxTotalUsd === undefined ? {} : { maxTotalUsd: caps.maxTotalUsd }),
  };
}

function provisionedSubject(config: LabConfig): ProvisionedSubject | undefined {
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
function desktopRequirements(
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

function brainOf(config: LabConfig, callerProvider: boolean): Brain {
  const actor = config.actors[0];
  if (callerProvider) return { kind: "caller" };
  if (actor?.type === "local-agent")
    return { kind: "local-agent", agent: actor.localAgent ?? "codex" };
  return { kind: "openai", model: actor?.model ?? DEFAULT_OPENAI_CU_MODEL };
}

function planComputerUse(
  config: LabConfig,
  options: RunLabOptions,
  base: Base,
): Built<ComputerUsePlan> {
  const hooks = options.cuaHooks ?? {};
  const executor = hooks.buildExecutor !== undefined;
  const provider = hooks.buildProvider !== undefined;
  if (executor && !provider) return "executor-without-provider";
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) return "unsupported-composition";
  const participants = computerUseParticipants(config, options.count);
  if (!isNonEmpty(participants)) return "unsupported-composition";
  if (participants.length > MAX_CUA_LANES) return "participant-cap";
  const source = config.subject.source;
  const appUrl = config.subject.appUrl ?? "";
  const brain = brainOf(config, provider);
  let runner: ComputerUseRunner;
  if (executor) {
    const [only, ...rest] = participants;
    if (rest.length > 0) return "in-process-fan-out";
    const subject =
      source === "local-app"
        ? ({ kind: "local-app", appUrl } as const)
        : source === "app-url"
          ? ({
              kind: "app-url",
              appUrl,
              publicTargets: config.policies?.allowPublicTargets === true,
            } as const)
          : undefined;
    if (subject === undefined) return "unsupported-composition";
    runner = { desktop: "in-process", brain: { kind: "caller" }, participants: [only], subject };
  } else if (source === "local-app") {
    return "local-app-without-executor";
  } else if (isLocalBrowserLab(config)) {
    if (config.policies?.allowPublicTargets === true) return "unsupported-composition";
    runner = {
      desktop: "local-vm",
      brain,
      participants,
      subject: { kind: "app-url", appUrl, publicTargets: false },
    };
  } else {
    const subject =
      source === "app-url"
        ? ({
            kind: "app-url",
            appUrl,
            publicTargets: config.policies?.allowPublicTargets === true,
          } as const)
        : source === "desktop-cli" && config.subject.product !== undefined
          ? ({ kind: "desktop-cli", product: config.subject.product } as const)
          : provisionedSubject(config);
    if (subject === undefined) return "unsupported-composition";
    runner = { desktop: "e2b-desktop", brain, participants, subject };
  }
  const declared = config.execution?.concurrency;
  const n = participants.length;
  const provisioned = source === "clone" || source === "local-tree";
  return {
    ...base,
    route: "computer-use",
    runner,
    concurrency: Math.max(1, declared === undefined ? n : Math.min(Math.max(1, declared), n)),
    sessionBudgetMs: config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config),
    sandboxMs: resolvePerLaneSandboxMs(config),
    caps: capsOf(config),
    ...(options.rerun === undefined
      ? {}
      : {
          rerun: {
            sourceRunId: options.rerun.sourceRunId,
            ...(options.rerun.laneIds === undefined
              ? {}
              : { participantIds: options.rerun.laneIds }),
          },
        }),
    requirements:
      base.dryRun || runner.desktop === "in-process"
        ? []
        : desktopRequirements(config, {
            e2b: runner.desktop === "e2b-desktop" && hooks.createDesktopLane === undefined,
            brain,
            localVm: runner.desktop === "local-vm",
            externalCatch: !provisioned,
          }),
  };
}

function planSharedWorld(config: LabConfig, base: Base): Built<SharedWorldPlan> {
  const seats = sharedWorldSeats(config);
  const actor = config.actors[0];
  const brain = brainOf(config, false);
  if (brain.kind === "caller" || !actorResolvesToComputerUse(actor?.type))
    return "unsupported-composition";
  let plane: SharedWorldPlane;
  if (seats.plane === "external-public") {
    const [first, second, ...rest] = seats.seats;
    const owner = config.subject.publicTarget?.owner;
    if (first === undefined || second === undefined || owner === undefined)
      return "unsupported-composition";
    plane = {
      kind: "external-public",
      appUrl: config.subject.appUrl ?? "",
      owner,
      participants: [first, second, ...rest],
    };
  } else {
    const [first, second, ...rest] = seats.seats;
    const subject = provisionedSubject(config);
    const checkpoint = subject?.state?.checkpoint ?? [];
    if (
      first === undefined ||
      second === undefined ||
      subject === undefined ||
      subject.state === undefined ||
      !isNonEmpty(checkpoint)
    )
      return "unsupported-composition";
    const participants: AtLeastTwo<(typeof seats.seats)[number]> = [first, second, ...rest];
    plane = {
      kind: "provisioned",
      subject: { ...subject, state: { ...subject.state, checkpoint } },
      participants,
    };
  }
  return {
    ...base,
    route: "shared-world",
    plane,
    concurrency: config.execution?.concurrency ?? plane.participants.length,
    brain,
    caps: capsOf(config),
    requirements: base.dryRun
      ? []
      : desktopRequirements(config, {
          e2b: true,
          brain,
          localVm: false,
          externalCatch: plane.kind === "external-public",
        }),
  };
}

function planTerminal(config: LabConfig, base: Base): Built<TerminalPlan> {
  const product = config.subject.product;
  const surfaces = product?.publicSurfaces ?? [];
  if (product === undefined || !isNonEmpty(surfaces)) return "unsupported-composition";
  const actor = config.actors[0];
  const runtime = {
    ...(config.execution?.runtime?.version === undefined
      ? {}
      : { version: config.execution.runtime.version }),
    ...(actor?.model === undefined ? {} : { model: actor.model }),
    ...(actor?.reasoningEffort === undefined ? {} : { reasoningEffort: actor.reasoningEffort }),
    ...(config.execution?.runtimeAuth === undefined ? {} : { auth: config.execution.runtimeAuth }),
  };
  const shared = {
    ...base,
    route: "terminal" as const,
    product: { ...product, publicSurfaces: surfaces },
    ...(actor?.persona === undefined ? {} : { personaId: actor.persona }),
    ...(actor?.mission === undefined ? {} : { mission: actor.mission }),
    runtime,
  };
  const caps = config.scenario?.caps;
  if (base.dryRun)
    return { ...shared, dryRun: true, ...(caps === undefined ? {} : { caps }), requirements: [] };
  const maxUsd = caps?.maxUsd;
  const maxMinutes = caps?.maxMinutes;
  if (caps === undefined || maxUsd === undefined || maxMinutes === undefined || maxMinutes <= 0)
    return "live-terminal-without-caps";
  return {
    ...shared,
    dryRun: false,
    caps: { ...caps, maxUsd, maxMinutes },
    requirements: [
      { kind: "key", name: "E2B_API_KEY" },
      { kind: "key-one-of", names: ["CODEX_API_KEY", "OPENAI_API_KEY"] },
    ],
  };
}

function planScripted(config: LabConfig, options: RunLabOptions, base: Base): Built<ScriptedPlan> {
  const scenarioRef = config.scenario?.ref;
  const surfaces = browserSurfaces.slice(0, config.actors[0]?.count ?? 1);
  if (scenarioRef === undefined || !isNonEmpty(surfaces)) return "unsupported-composition";
  let subject: ScriptedPlan["subject"];
  if (config.subject.source === "clone") {
    const provisioned = provisionedSubject(config);
    const seed = provisioned?.state?.seed ?? [];
    if (provisioned?.kind !== "clone" || provisioned.state === undefined || !isNonEmpty(seed))
      return "unsupported-composition";
    subject = { ...provisioned, state: { ...provisioned.state, seed } };
  } else {
    subject = { kind: "loopback", appUrl: config.subject.appUrl ?? "" };
  }
  const hooks = options.scriptedHooks ?? {};
  const injectedBrowser = hooks.launchBrowser !== undefined || hooks.browserCommand !== undefined;
  const requirements: Requirement[] = [];
  if (!base.dryRun && subject.kind === "clone") {
    requirements.push({ kind: "key", name: "E2B_API_KEY" });
    if (isNonEmpty(subject.env)) requirements.push({ kind: "subject-env", names: subject.env });
  }
  if (!base.dryRun && subject.kind === "loopback" && !injectedBrowser)
    requirements.push({ kind: "host-browser" });
  return {
    ...base,
    route: "scripted",
    subject,
    scenarioRef,
    surfaces,
    ...(config.actors[0]?.persona === undefined ? {} : { personaId: config.actors[0].persona }),
    ...(config.execution?.timeoutMs === undefined
      ? {}
      : { sessionTimeoutMs: config.execution.timeoutMs }),
    requirements,
  };
}

/**
 * The plan a lab runs under, built without reading files, env or the network. A combination the
 * plan types cannot hold comes back as the gap a route refuses today. Nothing dispatches on the
 * plan yet: each route adopts it in its own change, and the parser's composition rules still run
 * first.
 */
export function planLab(config: LabConfig, options: RunLabOptions): PlanResult {
  const route = routeOf(config);
  const lab = localBrowserDefaults(config);
  const analysis = resolveAutomaticAnalysis(lab.review?.analysis);
  if (!analysis.ok) return { ok: false, route, gap: "analysis-invalid" };
  const planned: PlannedAnalysis | undefined =
    analysis.config === undefined
      ? undefined
      : {
          config: analysis.config,
          trigger: lab.review?.analysis === undefined ? "default" : "explicit",
          preferLargerOutput: analysis.preferLargerOutput === true,
        };
  const base: Base = {
    labId: lab.id,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    residual: residualOf(lab),
    dryRun: resolveLabDryRun(lab, options.dryRun, true) ?? true,
    ...(planned === undefined ? {} : { analysis: planned }),
    requirements: [],
  };
  let plan: Built<LabPlan>;
  switch (route) {
    case "preview":
      plan = base.dryRun
        ? { ...base, route, dryRun: true, simCount: options.count ?? lab.actors[0]?.count ?? 4 }
        : "live-preview";
      break;
    case "computer-use":
      plan = planComputerUse(lab, options, base);
      break;
    case "shared-world":
      plan = planSharedWorld(lab, base);
      break;
    case "terminal":
      plan = planTerminal(lab, base);
      break;
    case "scripted":
      plan = planScripted(lab, options, base);
      break;
  }
  if (typeof plan === "string") return { ok: false, route, gap: plan };
  const bindings: LabBindings = {
    ...(options.cuaHooks === undefined ? {} : { cuaHooks: options.cuaHooks }),
    ...(options.scriptedHooks === undefined ? {} : { scriptedHooks: options.scriptedHooks }),
    ...(options.terminalHooks === undefined ? {} : { terminalHooks: options.terminalHooks }),
    ...(options.sharedWorldHooks === undefined
      ? {}
      : { sharedWorldHooks: options.sharedWorldHooks }),
  };
  return { ok: true, planned: { plan, bindings } };
}
