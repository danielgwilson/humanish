// The public RunStudyOptions homes that every route reads: env, scorer, prepareDesktop, onEvent,
// onStream and analysisSignal, and the brain and in-process driving computer use takes.

import type { CuaExecutor, CuaProvider } from "../actors/computer-use/loop.js";
import type { E2BDesktopSandbox } from "../substrates/e2b/sdk.js";
import type { AdapterScorerModule } from "./adapter-scorer-loader.js";
import { withDeprecatedFields } from "./deprecated-fields.js";
import type { StudyEvent, ParticipantRef, SetupTarget } from "./run-study-events.js";
import type { StudyConfig } from "./types.js";

/** What `createProvider` receives for each participant. */
export interface ProviderContext {
  readonly config: StudyConfig;
  readonly participant: ParticipantRef;
  readonly executor: CuaExecutor;
}

export type ProviderFactory = (ctx: ProviderContext) => Promise<CuaProvider>;

/** The caller's executor for an in-process run, built once for the run's single participant. */
export interface InProcessDriver {
  executor: (ctx: { config: StudyConfig; appUrl: string }) => Promise<CuaExecutor>;
}

interface StreamEventIds {
  participantId: string;
  /**
   * The id of this participant's entry in run.json `simulations[]` (`sim-001`), which
   * `streams[].simId` also holds.
   */
  recordId: string;
  streamId: string;
}

type StreamEventFields =
  | (StreamEventIds & {
      type: "ready";
      sandboxId: string;
      /** Runtime only: carries an auth key and must never be persisted. */
      url: string;
    })
  | (StreamEventIds & { type: "ended" });

export type StreamEvent = StreamEventFields & {
  /**
   * @deprecated Use `recordId`, which holds the same value. Reading it warns once per process; the
   * next minor removes it.
   */
  readonly simId: string;
};

/** A stream event as the routes report it, with `simId` as a getter over `recordId`. */
export function streamEvent(fields: StreamEventFields): StreamEvent {
  return withDeprecatedFields(
    { ...fields },
    { name: "StreamEvent", code: "HUMANISH_STREAM_EVENT_FIELD_DEPRECATED" },
    { simId: { replacement: "recordId", read: () => fields.recordId } },
  ) as StreamEvent;
}

/** The options with a typed home, common to every route. */
export interface RunStudyHomes {
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
  onEvent?: (event: StudyEvent) => void | Promise<void>;
  /** Awaited after a participant's live stream starts, and again after its sandbox is gone. */
  onStream?: (event: StreamEvent) => Promise<void> | void;
  /** Cancels post-run analysis only. */
  analysisSignal?: AbortSignal;
}

/** Brain and in-process driving. An in-process executor needs a provider: it returns no frame. */
export type RunStudyDriving =
  | { inProcess?: undefined; createProvider?: ProviderFactory }
  | {
      inProcess: InProcessDriver;
      createProvider: ProviderFactory;
    };
