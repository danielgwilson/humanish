// The streams[] records of run.json: one live or recorded view of a participant, with its
// completion, desktop geometry and assignment.

import type { CodexAppServerTrace } from "../actors/codex/app-server-trace.js";
import type { ActorStatus, ActorTrace, ActorTraceItem } from "../actors/contract.js";
import type { BrowserNetworkIndex } from "../evidence/browser-network.js";
import type { RunDesktopRecording } from "../evidence/desktop-recording-types.js";

export type RunStreamKind =
  | "ui"
  | "browser"
  | "terminal"
  | "tui"
  | "codex-ui"
  | "artifact"
  | "summary";

export type RunSimulationStatus =
  | "queued"
  | "preparing"
  | "running"
  | "passed"
  // Participant outcomes, not harness malfunctions (docs/principles/three-roles.md).
  | "abandoned"
  | "incomplete"
  | "complete"
  | "blocked"
  | "timed_out"
  | "failed"
  | "contract_proof_only";

/** Statuses a stream ends in. Analysis requires every stream of a run in one of these. */
export const TERMINAL_SIMULATION_STATUSES: ReadonlySet<RunSimulationStatus> = new Set([
  "complete",
  "passed",
  "failed",
  "blocked",
  "timed_out",
  "abandoned",
  "incomplete",
]);

interface RunStreamCompletion {
  actorLogPath?: string;
  actorLogTail?: string;
  actorLastMessageTail?: string;
  actorPid?: number;
  actorStatus?:
    | "not_started"
    | "running"
    | "passed"
    | "failed"
    | "blocked"
    | "timed_out"
    | "suspended"
    | "unknown";
  appLogPath?: string;
  appPid?: number;
  appReason?: string;
  appStatus?: "not_started" | "running" | "blocked" | "failed" | "missing" | "unknown";
  appUrl?: string;
  checkedAt: string;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  reason: string;
  status: "running" | "passed" | "failed" | "blocked" | "timed_out";
  visualReason?: string;
  visualStatus?: "not_started" | "visible" | "blocked" | "unknown";
  visualWindowCount?: number;
  meaningfulUse?: RunMeaningfulUseScore;
}

/**
 * The closed set of core meaningful-use scoring components. Closed by design: these are the generic
 * dimensions core itself meters (setup/filesystem/nested/actor/product/feedback). A
 * product-specific scorecard does not extend this enum, so adopters' nouns stay out of core. It
 * ships as a thin in-repo extension that emits a namespaced `RunAdapterScore` via the route's
 * `score` hook, leaving its own component breakdown in that score's `data`. Exported so a thin
 * adapter can type against core's score shape without forking.
 */
type RunMeaningfulUseComponentId =
  | "setup-correctness"
  | "filesystem-evidence"
  | "nested-humanish-evidence"
  | "actor-activity"
  | "product-surface"
  | "feedback-quality";

interface RunMeaningfulUseScore {
  schema: "humanish.meaningful-use-score.v1";
  status: "pass" | "partial" | "fail";
  score: number;
  summary: string;
  hardFailures: string[];
  components: Array<{
    id: RunMeaningfulUseComponentId;
    label: string;
    status: "pass" | "partial" | "fail";
    score: number;
    detail: string;
  }>;
}

export interface RunDesktopGeometry {
  /** E2B/X display geometry. Requested config and verified runtime evidence stay distinct. */
  screen: {
    requested: { width: number; height: number };
    verified?: { width: number; height: number; source: "xdpyinfo" };
    /**
     * The device preset as declared by the study, present only when it differs from `requested`
     * because the rendered width was floored to MIN_DESKTOP_RENDER_WIDTH.
     *
     * Without this, a floored run is indistinguishable from a faithful one: `verified` compares
     * the floored number with itself and reports a match, so a reader of the bundle sees
     * requested 500 / verified 500 and reasonably concludes a 500-wide preset was asked for. A
     * `mobile` (414) and a `small-mobile` (360) participant both render at 500 and look identical
     * here. When this field is set, the preset width did not render.
     */
    declared?: { width: number; height: number; preset: string };
  };
  /** Measured browser bounds after the fill attempt. X client bounds take precedence for
   * physical visibility; CDP page-reported outer bounds can reflect mobile emulation. */
  browserWindow?: {
    x: number;
    y: number;
    width: number;
    height: number;
    source: "cdp" | "xdotool" | "xwininfo";
  };
  /** Browser CSS layout viewport measured from the running page, never copied from config. */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    source: "cdp";
  };
  /**
   * Mobile fidelity beyond viewport size, present only when the study asked for it. `requested`
   * is what was applied through CDP; `resolved` is what the page reported about itself afterwards
   * and is the proof, never copied from the request. A run without this block is a
   * responsive-viewport study, whatever its preset is named.
   */
  fidelity?: {
    tier: "mobile-emulated";
    requested: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      touch: boolean;
      userAgent: string;
    };
    applied: string[];
    resolved?: {
      userAgent: string;
      devicePixelRatio: number;
      innerWidth: number;
      innerHeight: number;
      maxTouchPoints: number;
      coarsePointer: boolean;
      source: "cdp";
    };
    /**
     * Page targets the participant drove after the launch page (a link that opened in a new tab)
     * whose own read-back reported the requested viewport width. Absent when the
     * participant never left the launch tab; a later tab that did not report the width is a
     * participant warning instead.
     */
    laterTargets?: {
      targetId: string;
      innerWidth: number;
      devicePixelRatio: number;
      maxTouchPoints: number;
    }[];
    /**
     * The emulation holder's log after its announce, one JSON line per later target it attached
     * to (`attached`, `sent`) and per reply that came back as an error (`replyError`), at most 50
     * lines. Absent when no later target appeared.
     */
    holderLog?: string[];
  };
  /** Public-safe geometry measurement/fill warnings retained with the stream evidence. */
  warnings?: string[];
}

/**
 * A stream's trace file in a v2 run.json: the actor trace with its items and the stream's
 * screenshot entries as `artifacts`. `bytes` and `sha256` bind the file to run.json; `items` and
 * `screenshots` are what it holds, so a reader can list them without opening it.
 */
export interface StreamTraceIndex {
  path: string;
  bytes: number;
  sha256: string;
  items: number;
  screenshots: number;
}

/**
 * A v3 run.json's index of a running participant's live file (src/run/live-items.ts): its path
 * `live/<position>.<generation>.ndjson`, the generation, and the prefix written so far, as its item
 * (line) count, byte count and sha256. The file only grows, so the prefix stays as indexed.
 */
export interface LiveItemsIndex {
  path: string;
  generation: number;
  items: number;
  bytes: number;
  sha256: string;
}

/** The original participant-facing assignment, before runtime access/coordination details. */
export interface RunParticipantAssignment {
  mission: string;
  focus?: string;
  tasks?: Array<{ id: string; goal: string }>;
}

/** One file humanish copied onto a participant's desktop before it started (participants[].files). */
export interface RunDesktopFile {
  /** Where it landed, relative to the desktop user's home folder. */
  as: string;
  /** Its size in bytes, confirmed on the desktop. */
  size: number;
  /** The sha256 of the bytes humanish copied, 64 hex characters. */
  sha256: string;
}

export interface RunStream {
  id: string;
  simId: string;
  /** Adapter-owned participant id for fan-out / target-swarm runs. Safe categorical metadata only. */
  laneId?: string;
  /** Adapter-owned actor class for grouping participants, e.g. viewer/reviewer/admin. */
  actorType?: string;
  /** Adapter-owned product surface label for grouping participants without parsing URLs. */
  surface?: string;
  /** Adapter-owned scenario/case grouping label. */
  caseGroup?: string;
  /** Authored/default mission and participant focus, redacted before persistence. Missing on older
   * bundles and uninstrumented routes; never reconstructed from study context or narration. */
  assignment?: RunParticipantAssignment;
  kind: RunStreamKind;
  label: string;
  status: RunSimulationStatus;
  /**
   * The judge's status for this participant (`judgedStatus` in src/run/judge.ts). It differs from
   * the trace status when a goal_satisfied session reported a blocker or never engaged. Computer-use
   * and shared-world runs write it for a participant whose session finished; rerun selection and
   * the Observer read it. Absent on the terminal and scripted routes, whose judge has no blocker
   * rule, and in bundles written before it existed.
   */
  judgedStatus?: ActorStatus;
  transport: "snapshot" | "polling" | "sse" | "pty" | "app-server";
  updatedAt: string;
  url?: string;
  embed?: {
    kind: "iframe" | "terminal" | "screenshot" | "placeholder";
    url?: string;
    title?: string;
  };
  /** Set by the attached watch server when the participant's sandbox is gone: the injected live URL
   *  would render a provider error page, so viewers fall back to recorded evidence. Runtime-only
   *  and never persisted into bundles; declared here because the served observer-data carries it
   *  and the client is typed against this contract. */
  liveEnded?: boolean;
  /**
   * Set by a reader that shows the run (displayedTraces in src/run/stream-trace.ts) when the loader
   * refused this participant's trace: the reason. Runtime-only and never persisted; the stream then
   * carries none of the refused items.
   */
  traceUnavailable?: string;
  /**
   * Browser CSS layout viewport. Deterministic browser adapters may declare and render this
   * exactly; hosted-desktop CUA producers set it only from a runtime measurement. Historical
   * hosted CUA bundles may contain the requested screen size here instead.
   */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
  };
  /** Truthful screen/window/viewport evidence for hosted desktop browser participants. */
  desktopGeometry?: RunDesktopGeometry;
  /** The files copied onto this participant's desktop before it started. Never their contents. */
  desktopFiles?: RunDesktopFile[];
  /**
   * The participant's time zone (participants[].clock, else actor.clock): its turns gave the time
   * in it, and its hosted browser ran in it. Absent when it had none.
   */
  timeZone?: string;
  terminal?: {
    title: string;
    format: "ansi" | "plain";
    stdin: "disabled" | "planned" | "sent";
    tail: string;
  };
  ui?: {
    actorStatus?: string;
    appStatus?: string;
    appUrl?: string;
    route?: string;
    intent?: string;
    nestedObserverPath?: string;
    nestedObserverUrl?: string;
    screenshotUrl?: string;
    state?: string;
    visualStatus?: string;
  };
  codex?: {
    provider: "codex-app-server";
    eventCount?: number;
    experimentalApi?: boolean;
    model?: string;
    sessionId?: string;
    state:
      | "not_connected"
      | "connecting"
      | "watching"
      | "running"
      | "completed"
      | "failed"
      | "blocked"
      | "timed_out";
    contract: string;
    threadId?: string;
    trace?: CodexAppServerTrace;
    tracePath?: string;
    turnId?: string;
  };
  // Provider-neutral projection of the actor's evidence (humanish.actor-trace.v1).
  // Populated alongside the raw `codex` evidence; carries persona.traitsApplied. In a v2 run.json
  // it has no `items`: they are in the file `trace` names, and src/run/stream-trace.ts loads them.
  actor?: ActorTrace;
  /** Present in a v2 run.json on each stream with an actor: where its items and screenshots are. */
  trace?: StreamTraceIndex;
  /**
   * Mid-run partial actor evidence: the redacted trace items recorded so far,
   * flushed while a live participant is still running so the attached Observer's timeline can
   * grow. It is deliberately not an ActorTrace: a running participant has no final status,
   * completionReason, or completedAt, and this shape cannot claim them. Present only on
   * `inProgress` bundles; the final write replaces it with the real `actor` and never
   * carries it. A v3 run.json holds `humanish.live-actor.v2` with `itemsFile` in place of `items`;
   * the trace loader (src/run/stream-trace.ts) reads the file and puts the items back. A v4
   * run.json's live actor also leaves out `tokenUsage.turns` and `providerRequests`, which are
   * written only in the trace when the participant finishes, and carries the `estimatedCost` the
   * run writer priced from those rows.
   */
  liveActor?: {
    schema: "humanish.live-actor.v1" | "humanish.live-actor.v2";
    executionProfile?: ActorTrace["executionProfile"];
    providerRequests?: ActorTrace["providerRequests"];
    historyTurnsOmitted?: number;
    tokenUsage?: ActorTrace["tokenUsage"];
    estimatedCost?: ActorTrace["estimatedCost"];
    ids?: ActorTrace["ids"];
    /** When this flush was written (ISO-8601). */
    updatedAt: string;
    items: ActorTraceItem[];
    /** In a v3 run.json, in place of `items`: the live file that holds them. */
    itemsFile?: LiveItemsIndex;
  };
  completion?: RunStreamCompletion;
  recording?: RunDesktopRecording;
  /**
   * The participant's browser network log, when its study set `execution.network`: where the
   * file is, what binds it, and why records are missing. The shape guard does not read it; verify
   * checks it with the file (src/verify/network.ts).
   */
  network?: BrowserNetworkIndex;
  artifacts: Array<{
    label: string;
    path: string;
    kind:
      | "bundle"
      | "review"
      | "observer"
      | "events"
      | "screenshot"
      | "trace"
      | "log"
      | "filesystem"
      | "recording";
  }>;
}

/**
 * `T` without a participant's per-request lists (REQUEST_LISTS in src/run/stream-trace.ts):
 * `tokenUsage.turns`, `conversation.requests` and `providerRequests`. From run bundle v4 only the
 * trace file holds them, so a reader of run.json or of the Observer's data has none to read.
 */
export type WithoutRequestLists<T> = Omit<T, "providerRequests" | "tokenUsage" | "conversation"> & {
  [K in "tokenUsage" & keyof T]?: Omit<NonNullable<T[K]>, "turns"> | undefined;
} & { [K in "conversation" & keyof T]?: Omit<NonNullable<T[K]>, "requests"> | undefined };

/**
 * `T` WithoutRequestLists and with `items` optional: a v1 run.json holds the items inline, and from
 * v2 (an actor) or v3 (a live actor) a file holds them.
 */
type StoredTrace<T extends { items: unknown }> = WithoutRequestLists<Omit<T, "items">> &
  Partial<Pick<T, "items">>;

/**
 * A stream as run.json holds it, in any version: its actor and live actor without the per-request
 * lists, and with items only in a v1 run.json. loadStreamTraces joins both from the files.
 */
export type StoredRunStream = Omit<RunStream, "actor" | "liveActor"> & {
  actor?: StoredTrace<ActorTrace>;
  liveActor?: StoredTrace<NonNullable<RunStream["liveActor"]>>;
};

/**
 * A stream as a reader that shows the run has it (displayedTraces in src/run/stream-trace.ts):
 * loaded, or with `traceUnavailable` when the loader refused its trace. A refused stream's actor
 * keeps run.json's summary, which from v4 has none of the per-request lists, so the type has none.
 */
export type DisplayedRunStream = Omit<RunStream, "actor"> & {
  actor?: WithoutRequestLists<ActorTrace>;
};
