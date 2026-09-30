// The typed homes on RunLabOptions and the one place they meet the route hook bags. runLab calls
// normalizeRunLabOptions first: it refuses an option the route cannot honor, or a new option set
// together with the old field it replaces, and otherwise maps each new option into the bag the
// route reads today. Old fields pass through untouched, so they keep their exact behavior.

import path from "node:path";

import type { CuaExecutor, CuaProvider } from "../actors/computer-use/loop.js";
import { redactText, scrubLiterals, toErrorMessage } from "../evidence/redaction.js";
import { CUA_ACTOR_LAB_SCHEMA, type CuaActorLabHooks } from "../routes/computer-use/types.js";
import { SCRIPTED_BROWSER_LAB_SCHEMA } from "../routes/scripted-browser/lab.js";
import type { SharedWorldLabHooks } from "../routes/shared-world/hooks.js";
import { CONCURRENT_SHARED_WORLD_LAB_SCHEMA } from "../routes/shared-world/types.js";
import {
  TERMINAL_PRODUCT_LAB_SCHEMA,
  type TerminalProductLabHooks,
} from "../routes/terminal/types.js";
import type { E2BDesktopSandbox } from "../substrates/e2b/desktop-launch.js";
import { isLocalBrowserLab } from "../substrates/local/runtime-config.js";
import {
  defaultSharedWorldPhaseSink,
  defaultSubjectPhaseSink,
  type SubjectPhaseEvent,
} from "../subject/steps.js";
import type { AdapterScorerModule } from "./adapter-scorer-loader.js";
import { HOOK_MEMBERS, withHookOverrides } from "./hook-bag.js";
import type { LabOutcome, RunLabOptions } from "./engine.js";
import { computerUseParticipants, resolveLabDryRun, type LabRoute } from "./plan.js";
import type { LabConfig } from "./types.js";

/** One participant, as the options' callbacks see it. */
interface ParticipantRef {
  readonly id: string;
  /** 0-based position in the roster. */
  readonly index: number;
  readonly count: number;
}

/** Provisioned shared world and scripted clone labs prepare the shared subject sandbox first. */
type SetupTarget =
  | { readonly kind: "subject" }
  | { readonly kind: "participant"; readonly participant: ParticipantRef };

/** What `createProvider` receives for each participant. */
interface ProviderContext {
  readonly config: LabConfig;
  readonly participant: ParticipantRef;
  readonly executor: CuaExecutor;
}

type ProviderFactory = (ctx: ProviderContext) => Promise<CuaProvider>;

type StreamEvent =
  /** Runtime only: `url` carries an auth key and must never be persisted. */
  | {
      type: "ready";
      participantId: string;
      sandboxId: string;
      simId: string;
      streamId: string;
      url: string;
    }
  | { type: "ended"; participantId: string; simId: string; streamId: string };

/**
 * What a run reports while it runs. `plan` comes from computer use only; the other routes gain it
 * when they move onto the lab plan. `subject-phase` comes from computer use (participant target)
 * and shared world (subject target).
 */
export type LabEvent =
  | {
      type: "plan";
      route: LabRoute;
      participants: readonly {
        id: string;
        persona: string;
        device?: string;
        instructionDigest: string;
      }[];
    }
  | {
      type: "subject-phase";
      target: SetupTarget;
      name: string;
      message: string;
      at: string;
      ok?: boolean;
      durationMs?: number;
    }
  | { type: "analysis-started" }
  | { type: "analysis-finished" };

/** The options with a typed home, common to every route. */
export interface RunLabHomes {
  /** Keys and subject env for the run. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Scores the assembled evidence: computer use, shared world and terminal. */
  scorer?: AdapterScorerModule;
  /** E2B only. Runs after the sandbox exists and before provisioning, once per target. */
  prepareDesktop?: (desktop: E2BDesktopSandbox, target: SetupTarget) => Promise<void>;
  /**
   * Passive. Never awaited; a throw or a rejected promise becomes a run warning. It observes and
   * changes no output: subject phases still go to stderr.
   */
  onEvent?: (event: LabEvent) => void | Promise<void>;
  /** Awaited after a participant's live stream starts, and again after its sandbox is gone. */
  onStream?: (event: StreamEvent) => Promise<void> | void;
  /** Cancels post-run analysis only. */
  analysisSignal?: AbortSignal;
}

/** Brain and in-process driving. An in-process executor needs a provider: it returns no frame. */
export type RunLabDriving =
  | { inProcess?: undefined; createProvider?: ProviderFactory }
  | {
      inProcess: { executor: (ctx: { config: LabConfig; appUrl: string }) => Promise<CuaExecutor> };
      createProvider: ProviderFactory;
    };

type Refusal = {
  ok: false;
  code: "HUMANISH_LAB_OPTION_CONFLICT" | "HUMANISH_LAB_OPTION_UNSUPPORTED";
  message: string;
};

type Normalized = {
  ok: true;
  /** The options with every new field mapped into the old bags and removed. */
  options: RunLabOptions;
  /** Filled by onEvent failures while the run runs; runLab appends them to the result. */
  warnings: string[];
};

const conflict = (home: string, old: string): Refusal => ({
  ok: false,
  code: "HUMANISH_LAB_OPTION_CONFLICT",
  message: `RunLabOptions.${home} and ${old} are both set. ${old} is the older form of ${home}; set only ${home}.`,
});

const unsupported = (option: string, route: LabRoute, reason: string): Refusal => ({
  ok: false,
  code: "HUMANISH_LAB_OPTION_UNSUPPORTED",
  message: `RunLabOptions.${option} is not supported on the ${route} route: ${reason}`,
});

/**
 * Whether a caller's bag sets `key`, from its property descriptors: a data property counts when its
 * value is defined, an accessor counts without being called. Nothing the caller defined runs.
 */
function hasMember(bag: object | undefined, key: string): boolean {
  for (
    let source: object | null = bag ?? null;
    source !== null && source !== Object.prototype;
    source = Object.getPrototypeOf(source) as object | null
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor !== undefined)
      return "value" in descriptor ? descriptor.value !== undefined : true;
  }
  return false;
}

/**
 * The first old field set together with its new home, as [home, old field]. The new option is
 * checked first, so a legacy-only call never looks at its bags.
 */
function conflictingField(options: RunLabOptions): [string, string] | undefined {
  const pairs: [home: string, bag: string, member: string][] = [
    ["env", "cuaHooks", "env"],
    ["env", "scriptedHooks", "env"],
    ["env", "terminalHooks", "env"],
    ["env", "sharedWorldHooks", "env"],
    ["scorer", "cuaHooks", "score"],
    ["scorer", "cuaHooks", "deriveFeedback"],
    ["scorer", "cuaHooks", "deriveArtifacts"],
    ["scorer", "sharedWorldHooks", "score"],
    ["scorer", "sharedWorldHooks", "deriveFeedback"],
    ["scorer", "sharedWorldHooks", "deriveArtifacts"],
    ["scorer", "terminalHooks", "score"],
    ["scorer", "terminalHooks", "deriveFeedback"],
    ["prepareDesktop", "cuaHooks", "prepareDesktop"],
    ["prepareDesktop", "scriptedHooks", "prepareDesktop"],
    ["prepareDesktop", "sharedWorldHooks", "prepareDesktop"],
    ["onEvent", "cuaHooks", "onPreflight"],
    ["onEvent", "cuaHooks", "onPhase"],
    ["onEvent", "sharedWorldHooks", "onPhase"],
    ["onEvent", "automaticAnalysis", "onStart"],
    ["onStream", "cuaHooks", "onRuntimeStreamReady"],
    ["onStream", "cuaHooks", "onRuntimeStreamEnded"],
    ["onStream", "sharedWorldHooks", "onRuntimeStreamReady"],
    ["onStream", "sharedWorldHooks", "onRuntimeStreamEnded"],
    ["analysisSignal", "automaticAnalysis.deps", "signal"],
    ["createProvider", "cuaHooks", "buildProvider"],
    ["inProcess", "cuaHooks", "buildExecutor"],
    ["rerun.participantIds", "rerun", "laneIds"],
  ];
  const home = (name: string): boolean =>
    name === "rerun.participantIds"
      ? options.rerun?.participantIds !== undefined
      : options[name as keyof RunLabHomes | "createProvider" | "inProcess"] !== undefined;
  const bagOf = (name: string): object | undefined =>
    name === "automaticAnalysis.deps"
      ? options.automaticAnalysis?.deps
      : (options[name as keyof RunLabOptions] as object | undefined);
  const found = pairs.find(([name, bag, member]) => home(name) && hasMember(bagOf(bag), member));
  return found === undefined ? undefined : [found[0], `${found[1]}.${found[2]}`];
}

/** Why the route cannot honor an option it was given, or undefined when it can. */
function unsupportedOption(
  config: LabConfig,
  route: LabRoute,
  options: RunLabOptions,
): Refusal | undefined {
  const { scorer, createProvider, inProcess, prepareDesktop } = options;
  if (inProcess !== undefined && createProvider === undefined)
    return unsupported(
      "inProcess",
      route,
      "an in-process executor returns no frame, so it needs createProvider.",
    );
  const participantRoute = route === "computer-use" || route === "shared-world";
  if (scorer !== undefined && route !== "terminal" && !participantRoute)
    return unsupported("scorer", route, "only computer use, shared world and terminal score runs.");
  if (createProvider !== undefined && route !== "computer-use")
    return unsupported(
      "createProvider",
      route,
      route === "shared-world"
        ? "shared-world seats run the lab's own brain."
        : "only computer use takes a caller brain.",
    );
  if (route === "computer-use") {
    const source = config.subject.source;
    if (inProcess !== undefined) {
      if (source !== "app-url" && source !== "local-app")
        return unsupported("inProcess", route, "it drives an app-url or local-app subject.");
      if (computerUseParticipants(config, options.count).length !== 1)
        return unsupported("inProcess", route, "it drives exactly one participant.");
    }
    if (prepareDesktop !== undefined) {
      if (isLocalBrowserLab(config))
        return unsupported("prepareDesktop", route, "a local VM study has no E2B desktop.");
      // The run is in process when either executor home is set: inProcess or the older
      // cuaHooks.buildExecutor. Either way no desktop exists to prepare.
      if (
        inProcess !== undefined ||
        hasMember(options.cuaHooks, "buildExecutor") ||
        source === "local-app"
      )
        return unsupported("prepareDesktop", route, "an in-process run has no desktop.");
    }
    return undefined;
  }
  if (inProcess !== undefined)
    return unsupported("inProcess", route, "only computer use drives an app in process.");
  if (prepareDesktop === undefined || route === "shared-world") return undefined;
  if (route === "scripted" && config.subject.source === "clone") return undefined;
  return unsupported(
    "prepareDesktop",
    route,
    route === "scripted"
      ? "only a clone subject runs on an E2B desktop."
      : "this route has no E2B desktop to prepare.",
  );
}

/**
 * The literal values to scrub from an onEvent warning: the provider keys and the declared subject
 * env from every env the run could read (the `env` option, each bag's env, process.env), and the
 * analysis API key. A callback can hold any of them, and its warning is appended after the route
 * sanitized its own.
 */
function knownSecretValues(
  config: LabConfig,
  options: RunLabOptions,
  forwardedEnv: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  const sources = [
    forwardedEnv,
    options.env,
    options.cuaHooks?.env,
    options.scriptedHooks?.env,
    options.terminalHooks?.env,
    options.sharedWorldHooks?.env,
    process.env,
  ];
  const names = ["OPENAI_API_KEY", "E2B_API_KEY", "CODEX_API_KEY", ...(config.subject.env ?? [])];
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length >= 4) values.add(trimmed);
  };
  for (const env of sources) for (const name of names) add(env?.[name]);
  add(options.automaticAnalysis?.deps?.apiKey);
  return [...values];
}

/**
 * Refuse what the route cannot honor, then map the new options into the old bags. Nothing here
 * touches the filesystem, so a refusal leaves no run directory, receipt or sandbox.
 */
export function normalizeRunLabOptions(
  config: LabConfig,
  route: LabRoute,
  options: RunLabOptions,
): Normalized | Refusal {
  const clash = conflictingField(options);
  if (clash) return conflict(...clash);
  const refused = unsupportedOption(config, route, options);
  if (refused) return refused;

  const warnings: string[] = [];
  const {
    env,
    scorer,
    prepareDesktop,
    onEvent,
    onStream,
    analysisSignal,
    createProvider,
    inProcess,
    ...legacy
  } = options;
  // The route gets this copy, so it is the env a warning is scrubbed against, whatever the caller
  // does to its own object afterwards.
  const forwardedEnv = env === undefined ? undefined : { ...env };
  const emit =
    onEvent === undefined
      ? undefined
      : (event: LabEvent): void => {
          // Read before the callback runs: the callback can redefine anything on the event.
          const type = event.type;
          // Total: a thrown value can refuse to become a string, and nothing may escape from here.
          const report = (error: unknown): void => {
            let detail: string;
            try {
              // Read here, not up front: a run with no failing callback never touches the env.
              const scrub = scrubLiterals(knownSecretValues(config, options, forwardedEnv));
              detail = redactText(scrub(toErrorMessage(error)));
            } catch {
              detail = "the thrown value has no message";
            }
            warnings.push(`RunLabOptions.onEvent failed on ${type}: ${detail}`);
          };
          try {
            const returned = onEvent(event);
            if (returned !== undefined) Promise.resolve(returned).then(undefined, report);
          } catch (error) {
            report(error);
          }
        };

  const normalized: RunLabOptions = { ...legacy };
  const participantIds = options.rerun?.participantIds;
  if (options.rerun !== undefined && participantIds !== undefined) {
    const { participantIds: _ids, ...rerun } = options.rerun;
    normalized.rerun = { ...rerun, laneIds: participantIds };
  }
  const analysis = withMapped(legacy.automaticAnalysis, HOOK_MEMBERS.analysis, {
    ...(analysisSignal === undefined
      ? {}
      : { deps: { ...legacy.automaticAnalysis?.deps, signal: analysisSignal } }),
    ...(emit === undefined
      ? {}
      : {
          onStart: () => {
            emit({ type: "analysis-started" });
            return () => emit({ type: "analysis-finished" });
          },
        }),
  });
  if (analysis !== undefined) normalized.automaticAnalysis = analysis;
  const envHome = forwardedEnv === undefined ? {} : { env: forwardedEnv };
  const scoring = scorer === undefined ? {} : scorerHooks(scorer);
  switch (route) {
    case "computer-use": {
      const hooks = withMapped(legacy.cuaHooks, HOOK_MEMBERS.cua, {
        ...envHome,
        ...scoring,
        ...computerUseHooks(
          config,
          {
            prepareDesktop,
            onStream,
            createProvider,
            inProcess,
            legacyInProcess: hasMember(legacy.cuaHooks, "buildExecutor"),
          },
          emit,
        ),
      });
      if (hooks !== undefined) normalized.cuaHooks = hooks;
      break;
    }
    case "shared-world": {
      const hooks = withMapped(legacy.sharedWorldHooks, HOOK_MEMBERS.sharedWorld, {
        ...envHome,
        ...scoring,
        ...sharedWorldHooks({ prepareDesktop, onStream }, emit),
      });
      if (hooks !== undefined) normalized.sharedWorldHooks = hooks;
      break;
    }
    case "terminal": {
      const hooks = withMapped<TerminalProductLabHooks>(
        legacy.terminalHooks,
        HOOK_MEMBERS.terminal,
        {
          ...envHome,
          ...(scorer?.score === undefined ? {} : { score: scorer.score }),
          ...(scorer?.deriveFeedback === undefined
            ? {}
            : { deriveFeedback: scorer.deriveFeedback }),
        },
      );
      if (hooks !== undefined) normalized.terminalHooks = hooks;
      break;
    }
    case "scripted": {
      const hooks = withMapped(legacy.scriptedHooks, HOOK_MEMBERS.scripted, {
        ...envHome,
        ...(prepareDesktop === undefined
          ? {}
          : {
              prepareDesktop: (desktop: E2BDesktopSandbox) =>
                prepareDesktop(desktop, { kind: "subject" }),
            }),
      });
      if (hooks !== undefined) normalized.scriptedHooks = hooks;
      break;
    }
    case "preview":
      break;
  }
  return { ok: true, options: normalized, warnings };
}

/** A caller's bag with new options mapped into it. With nothing to map, it is the same object. */
function withMapped<T extends object>(
  bag: T | undefined,
  declared: readonly string[],
  mapped: Partial<T>,
): T | undefined {
  if (Object.keys(mapped).length === 0) return bag;
  return withHookOverrides(bag, declared, mapped);
}

function scorerHooks(
  scorer: AdapterScorerModule,
): Pick<CuaActorLabHooks, "score" | "deriveFeedback" | "deriveArtifacts"> {
  return {
    ...(scorer.score === undefined ? {} : { score: scorer.score }),
    ...(scorer.deriveFeedback === undefined ? {} : { deriveFeedback: scorer.deriveFeedback }),
    ...(scorer.deriveArtifacts === undefined ? {} : { deriveArtifacts: scorer.deriveArtifacts }),
  };
}

type Lane = { laneId: string; laneIndex: number; laneCount: number };

const participantOf = (lane: Lane): ParticipantRef => ({
  id: lane.laneId,
  index: lane.laneIndex,
  count: lane.laneCount,
});

function phaseEvent(event: SubjectPhaseEvent, target: SetupTarget): LabEvent {
  return {
    type: "subject-phase",
    target,
    name: event.type,
    message: event.message,
    at: event.at,
    ...(event.ok === undefined ? {} : { ok: event.ok }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
  };
}

/** The route awaits what these return, so onStream keeps the old hooks' barrier and errors. */
function streamHooks(
  onStream: NonNullable<RunLabHomes["onStream"]>,
): Pick<CuaActorLabHooks, "onRuntimeStreamReady" | "onRuntimeStreamEnded"> {
  return {
    onRuntimeStreamReady: (stream) =>
      onStream({
        type: "ready",
        participantId: stream.laneId,
        sandboxId: stream.sandboxId,
        simId: stream.simId,
        streamId: stream.streamId,
        url: stream.url,
      }),
    onRuntimeStreamEnded: (stream) =>
      onStream({
        type: "ended",
        participantId: stream.laneId,
        simId: stream.simId,
        streamId: stream.streamId,
      }),
  };
}

function computerUseHooks(
  config: LabConfig,
  homes: {
    prepareDesktop: RunLabHomes["prepareDesktop"];
    onStream: RunLabHomes["onStream"];
    createProvider: ProviderFactory | undefined;
    inProcess: Extract<RunLabDriving, { inProcess: object }>["inProcess"] | undefined;
    /** The caller set the older cuaHooks.buildExecutor, so the run is in process. */
    legacyInProcess: boolean;
  },
  emit: ((event: LabEvent) => void) | undefined,
): CuaActorLabHooks {
  const { prepareDesktop, onStream, createProvider, inProcess, legacyInProcess } = homes;
  // A local VM study and an in-process run start no E2B stream, and the local study refuses a
  // stream hook outright, so onStream is left unset there: it is never called.
  const streams = !isLocalBrowserLab(config) && inProcess === undefined && !legacyInProcess;
  return {
    ...(prepareDesktop === undefined
      ? {}
      : {
          prepareDesktop: (desktop, lane) =>
            prepareDesktop(desktop, { kind: "participant", participant: participantOf(lane) }),
        }),
    ...(createProvider === undefined
      ? {}
      : {
          buildProvider: ({ config: lab, lane, laneCount, executor }) =>
            createProvider({
              config: lab,
              participant: participantOf({ ...lane, laneCount }),
              executor,
            }),
        }),
    ...(inProcess === undefined
      ? {}
      : {
          buildExecutor: ({ config: lab, appUrl }) => inProcess.executor({ config: lab, appUrl }),
        }),
    ...(onStream !== undefined && streams ? streamHooks(onStream) : {}),
    ...(emit === undefined
      ? {}
      : {
          onPreflight: (plan) =>
            emit({
              type: "plan",
              route: "computer-use",
              participants: plan.lanes.map((lane) => ({
                id: lane.id,
                persona: lane.persona,
                device: lane.device,
                instructionDigest: lane.instructionDigest,
              })),
            }),
          onPhase: (event, lane) => {
            defaultSubjectPhaseSink(event, lane);
            emit(phaseEvent(event, { kind: "participant", participant: participantOf(lane) }));
          },
        }),
  };
}

function sharedWorldHooks(
  homes: { prepareDesktop: RunLabHomes["prepareDesktop"]; onStream: RunLabHomes["onStream"] },
  emit: ((event: LabEvent) => void) | undefined,
): SharedWorldLabHooks {
  const { prepareDesktop, onStream } = homes;
  return {
    ...(prepareDesktop === undefined
      ? {}
      : {
          // The provisioned plane prepares the subject sandbox with no lane, then each seat.
          prepareDesktop: (desktop, lane) =>
            prepareDesktop(
              desktop,
              lane === undefined
                ? { kind: "subject" }
                : { kind: "participant", participant: participantOf(lane) },
            ),
        }),
    ...(onStream === undefined ? {} : streamHooks(onStream)),
    ...(emit === undefined
      ? {}
      : {
          onPhase: (event) => {
            defaultSharedWorldPhaseSink(event);
            emit(phaseEvent(event, { kind: "subject" }));
          },
        }),
  };
}

/** A refusal in the route's own result envelope, before any run exists. */
export function optionRefusalOutcome(
  config: LabConfig,
  route: LabRoute,
  options: RunLabOptions,
  refusal: Refusal,
): LabOutcome {
  const cwd = path.resolve(options.cwd);
  const error = { code: refusal.code, message: refusal.message };
  const actor = config.actors[0]?.type ?? "";
  const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
  const runId = options.runId ?? "not-created";
  const common = { ok: false, cwd, labId: config.id, actor, dryRun, runId, warnings: [], error };
  switch (route) {
    case "preview":
      return {
        backend: "synthetic",
        result: { schema: "humanish.run-result.v1", ok: false, cwd, warnings: [], error },
      };
    case "computer-use":
      return {
        backend: "cua",
        result: {
          schema: CUA_ACTOR_LAB_SCHEMA,
          ...common,
          ok: false,
          appUrl: config.subject.appUrl ?? config.subject.serve?.url ?? "",
          lanes: [],
        },
      };
    case "scripted":
      return {
        backend: "scripted",
        result: {
          schema: SCRIPTED_BROWSER_LAB_SCHEMA,
          ...common,
          ok: false,
          appUrl: config.subject.appUrl ?? "",
          sessions: [],
        },
      };
    case "terminal":
      return {
        backend: "terminal",
        result: {
          schema: TERMINAL_PRODUCT_LAB_SCHEMA,
          ...common,
          ok: false,
          product: config.subject.product?.name ?? "",
        },
      };
    case "shared-world": {
      const roleCount = config.actors[0]?.lanes?.length ?? 0;
      return {
        backend: "concurrent-shared-world",
        result: {
          schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
          ...common,
          ok: false,
          topology: "shared-world",
          topologyMode: "concurrent",
          roleCount,
          concurrency: config.execution?.concurrency ?? Math.max(1, roleCount),
          roles: [],
        },
      };
    }
  }
}
