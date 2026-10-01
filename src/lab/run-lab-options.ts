// The typed homes on RunLabOptions and the one place they meet the route hook bags. runLab calls
// normalizeRunLabOptions first: it refuses an option the route cannot honor, or a new option set
// together with the old field it replaces, and otherwise maps each new option into the bag the
// route reads today. Old fields pass through untouched, so they keep their exact behavior.

import path from "node:path";

import type { CuaExecutor, CuaProvider } from "../actors/computer-use/loop.js";
import { CUA_ACTOR_LAB_SCHEMA, type CuaActorLabHooks } from "../routes/computer-use/types.js";
import { SCRIPTED_BROWSER_LAB_SCHEMA } from "../routes/scripted-browser/types.js";
import type { SharedWorldLabHooks } from "../routes/shared-world/types.js";
import { CONCURRENT_SHARED_WORLD_LAB_SCHEMA } from "../routes/shared-world/types.js";
import {
  TERMINAL_PRODUCT_LAB_SCHEMA,
  type TerminalProductLabHooks,
} from "../routes/terminal/types.js";
import type { E2BDesktopSandbox } from "../substrates/e2b/sdk.js";
import { isLocalBrowserLab } from "../substrates/local/runtime-config.js";
import { defaultSharedWorldPhaseSink, defaultSubjectPhaseSink } from "../subject/steps.js";
import type { AdapterScorerModule } from "./adapter-scorer-loader.js";
import { HOOK_MEMBERS, withHookOverrides } from "./hook-bag.js";
import type { LabOutcome, RunLabOptions } from "../run-lab.js";
import { resolveLabDryRun, type LabRoute } from "./plan.js";
import { computerUseParticipants } from "./plan-participants.js";
import type { LabConfig } from "./types.js";
import {
  knownSecretValues,
  labEventEmitter,
  participantOf,
  phaseEvent,
  planEvent,
  type LabEvent,
  type ParticipantRef,
  type SetupTarget,
} from "./run-lab-events.js";

/** What `createProvider` receives for each participant. */
export interface ProviderContext {
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
 * Every old field the options set that has a new home, and whether its home is set too. Presence
 * comes from property descriptors (hasMember), so no getter of the caller's runs.
 */
function oldFieldsInUse(options: RunLabOptions): { home: string; old: string; clash: boolean }[] {
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
  return pairs
    .filter(([, bag, member]) => hasMember(bagOf(bag), member))
    .map(([name, bag, member]) => ({ home: name, old: `${bag}.${member}`, clash: home(name) }));
}

/** Old fields removed in the next minor with no replacement. They warn, and they never clash. */
function retiredFieldsInUse(options: RunLabOptions): string[] {
  return hasMember(options.cuaHooks, "createDesktopLane") ? ["cuaHooks.createDesktopLane"] : [];
}

const warned = new Set<string>();

/** One DeprecationWarning per old field per process. The bags' other test seams never warn. */
function warnDeprecated(home: string | undefined, old: string): void {
  if (warned.has(old)) return;
  warned.add(old);
  const replacement = home === undefined ? "It has no replacement." : `Use RunLabOptions.${home}.`;
  process.emitWarning(
    `RunLabOptions.${old} is deprecated and is removed in the next minor. ${replacement}`,
    { type: "DeprecationWarning", code: "HUMANISH_RUN_LAB_OPTION_DEPRECATED" },
  );
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
 * Refuse what the route cannot honor, then map the new options into the old bags. Nothing here
 * touches the filesystem, so a refusal leaves no run directory, receipt or sandbox.
 */
export function normalizeRunLabOptions(
  config: LabConfig,
  route: LabRoute,
  options: RunLabOptions,
): Normalized | Refusal {
  const inUse = oldFieldsInUse(options);
  const clash = inUse.find((field) => field.clash);
  if (clash) return conflict(clash.home, clash.old);
  const refused = unsupportedOption(config, route, options);
  if (refused) return refused;
  for (const { home, old } of inUse) warnDeprecated(home, old);
  for (const old of retiredFieldsInUse(options)) warnDeprecated(undefined, old);

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
  const emit = labEventEmitter(onEvent, warnings, () =>
    knownSecretValues(config, options, forwardedEnv),
  );

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
          prepareDesktop: (desktop, participant) =>
            prepareDesktop(desktop, {
              kind: "participant",
              participant: participantOf(participant),
            }),
        }),
    ...(createProvider === undefined
      ? {}
      : {
          buildProvider: ({ config: lab, lane: participant, laneCount, executor }) =>
            createProvider({
              config: lab,
              participant: participantOf({ ...participant, laneCount }),
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
          onPreflight: (plan) => emit(planEvent(plan)),
          onPhase: (event, participant) => {
            defaultSubjectPhaseSink(event, participant);
            emit(
              phaseEvent(event, { kind: "participant", participant: participantOf(participant) }),
            );
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
          // The provisioned plane prepares the subject sandbox with no participant, then each one.
          prepareDesktop: (desktop, participant) =>
            prepareDesktop(
              desktop,
              participant === undefined
                ? { kind: "subject" }
                : { kind: "participant", participant: participantOf(participant) },
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
        route: "preview",
        backend: "synthetic",
        result: { schema: "humanish.run-result.v1", ok: false, cwd, warnings: [], error },
      };
    case "computer-use":
      return {
        route: "computer-use",
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
        route: "scripted",
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
        route: "terminal",
        backend: "terminal",
        result: {
          schema: TERMINAL_PRODUCT_LAB_SCHEMA,
          ...common,
          ok: false,
          product: config.subject.product?.name ?? "",
        },
      };
    case "shared-world": {
      const participantCount = config.actors[0]?.lanes?.length ?? 0;
      return {
        route: "shared-world",
        backend: "concurrent-shared-world",
        result: {
          schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
          ...common,
          ok: false,
          topology: "shared-world",
          topologyMode: "concurrent",
          roleCount: participantCount,
          concurrency: config.execution?.concurrency ?? Math.max(1, participantCount),
          roles: [],
        },
      };
    }
  }
}
