// The typed homes on RunLabOptions and the one place they meet the route hook bags. runLab calls
// normalizeRunLabOptions first: it refuses an option the route cannot honor and otherwise maps each
// typed option into the bag the route reads today. The bags themselves are internal: only tests
// set them, and the package's runLab refuses them (removedOptionRefusal).

import path from "node:path";

import type { CuaExecutor, CuaProvider } from "../actors/computer-use/loop.js";
import { CUA_ACTOR_LAB_SCHEMA, type CuaActorLabHooks } from "../routes/computer-use/types.js";
import { SCRIPTED_BROWSER_LAB_SCHEMA } from "../routes/scripted/types.js";
import type { SharedWorldLabHooks } from "../routes/shared-world/types.js";
import { CONCURRENT_SHARED_WORLD_LAB_SCHEMA } from "../routes/shared-world/types.js";
import { TERMINAL_PRODUCT_LAB_SCHEMA } from "../routes/terminal/types.js";
import type { E2BDesktopSandbox } from "../substrates/e2b/sdk.js";
import { isLocalBrowserLab } from "../substrates/local/runtime-config.js";
import { defaultSharedWorldPhaseSink, defaultSubjectPhaseSink } from "../subject/steps.js";
import type { AdapterScorerModule } from "./adapter-scorer-loader.js";
import type { InternalRunLabOptions, LabOutcome, RunLabOptions } from "../run-lab.js";
import { resolveLabDryRun, type LabRoute } from "./plan.js";
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
import { rosterOf } from "./parse/actors.js";

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
  /**
   * Scores the assembled evidence: computer use, shared world and terminal. A scorer written for
   * one context passes through `browserScorer` or `terminalScorer`; one that narrows `ctx` at
   * runtime passes as it is.
   */
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
  /** The options with each typed home mapped into the route's bag and removed, except on a route
   *  that reads its homes directly (terminal, scripted). */
  options: InternalRunLabOptions;
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

let olderRerunNameWarned = false;

/** `rerun.laneIds`, the older name of `rerun.participantIds`, warns once per process. */
function warnOlderRerunName(): void {
  if (olderRerunNameWarned) return;
  olderRerunNameWarned = true;
  process.emitWarning(
    "RunLabOptions.rerun.laneIds is deprecated and is removed in the next minor. Use RunLabOptions.rerun.participantIds.",
    { type: "DeprecationWarning", code: "HUMANISH_RUN_LAB_OPTION_DEPRECATED" },
  );
}

// Fields RunLabOptions no longer has, and where each one's job went.
const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  cuaHooks: "Use scorer, createProvider, inProcess, prepareDesktop, env, onEvent and onStream.",
  scriptedHooks: "Use prepareDesktop and env.",
  terminalHooks: "Use scorer and env.",
  sharedWorldHooks: "Use scorer, prepareDesktop, env, onEvent and onStream.",
  automaticAnalysis: "Use onEvent (analysis-started, analysis-finished) and analysisSignal.",
  lab: "The humanish CLI sets it.",
  scorerProvenance: "The humanish CLI sets it.",
};

/** The refusal for a field a JavaScript caller passed that RunLabOptions no longer has. */
export function removedOptionRefusal(options: RunLabOptions): Refusal | undefined {
  const field = Object.keys(REMOVED_OPTIONS).find((key) => Reflect.get(options, key) !== undefined);
  if (field === undefined) return undefined;
  return {
    ok: false,
    code: "HUMANISH_LAB_OPTION_UNSUPPORTED",
    message: `RunLabOptions.${field} was removed. ${REMOVED_OPTIONS[field]} See docs/contracts/schemas.md, "Library options".`,
  };
}

/** Why the route cannot honor an option it was given, or undefined when it can. */
function unsupportedOption(
  config: LabConfig,
  route: LabRoute,
  options: InternalRunLabOptions,
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
        ? "shared-world participants run the lab's own brain."
        : "only computer use takes a caller brain.",
    );
  if (route === "computer-use") {
    const source = config.subject.source;
    if (inProcess !== undefined) {
      if (source !== "app-url" && source !== "local-app")
        return unsupported("inProcess", route, "it drives an app-url or local-app subject.");
    }
    if (prepareDesktop !== undefined) {
      if (isLocalBrowserLab(config))
        return unsupported("prepareDesktop", route, "a local VM study has no E2B desktop.");
      // The run is in process when either executor home is set: inProcess or the older
      // cuaHooks.buildExecutor. Either way no desktop exists to prepare.
      if (
        inProcess !== undefined ||
        options.cuaHooks?.buildExecutor !== undefined ||
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
 * Refuse what the route cannot honor, then map the typed options into the route's bag. Nothing
 * here touches the filesystem, so a refusal leaves no run directory, receipt or sandbox.
 */
export function normalizeRunLabOptions(
  config: LabConfig,
  route: LabRoute,
  options: InternalRunLabOptions,
): Normalized | Refusal {
  const olderRerunIds = options.rerun?.laneIds;
  if (olderRerunIds !== undefined && options.rerun?.participantIds !== undefined)
    return conflict("rerun.participantIds", "rerun.laneIds");
  const refused = unsupportedOption(config, route, options);
  if (refused) return refused;
  if (olderRerunIds !== undefined) warnOlderRerunName();

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

  const normalized: InternalRunLabOptions = { ...legacy };
  const participantIds = options.rerun?.participantIds;
  if (options.rerun !== undefined && participantIds !== undefined) {
    const { participantIds: _ids, ...rerun } = options.rerun;
    normalized.rerun = { ...rerun, laneIds: participantIds };
  }
  const analysis = withMapped(legacy.automaticAnalysis, {
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
  // Every scoring route reads scorer itself.
  if (scorer !== undefined) normalized.scorer = scorer;
  switch (route) {
    case "computer-use": {
      const hooks = withMapped(legacy.cuaHooks, {
        ...envHome,
        ...computerUseHooks(
          config,
          {
            prepareDesktop,
            onStream,
            createProvider,
            inProcess,
            legacyInProcess: legacy.cuaHooks?.buildExecutor !== undefined,
          },
          emit,
        ),
      });
      if (hooks !== undefined) normalized.cuaHooks = hooks;
      break;
    }
    case "shared-world": {
      const hooks = withMapped(legacy.sharedWorldHooks, {
        ...envHome,
        ...sharedWorldHooks({ prepareDesktop, onStream }, emit),
      });
      if (hooks !== undefined) normalized.sharedWorldHooks = hooks;
      break;
    }
    case "terminal":
      // The terminal route reads its typed options directly.
      if (forwardedEnv !== undefined) normalized.env = forwardedEnv;
      break;
    case "scripted":
      // The scripted route reads its typed options directly.
      if (forwardedEnv !== undefined) normalized.env = forwardedEnv;
      if (prepareDesktop !== undefined) normalized.prepareDesktop = prepareDesktop;
      break;
    case "preview":
      break;
  }
  return { ok: true, options: normalized, warnings };
}

/** A bag with typed options mapped over it. With nothing to map, it is the same object. */
function withMapped<T extends object>(bag: T | undefined, mapped: Partial<T>): T | undefined {
  if (Object.keys(mapped).length === 0) return bag;
  return { ...bag, ...mapped } as T;
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
      const participantCount = rosterOf(config.actors[0])?.length ?? 0;
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
