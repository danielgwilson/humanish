// The streams[] records of run.json: one live or recorded view of a participant, with its
// completion, desktop geometry and assignment.

import type { CodexAppServerTrace } from "../actors/codex/app-server-trace.js";
import type { ActorTrace, ActorTraceItem } from "../actors/contract.js";
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
 * The CLOSED set of core meaningful-use scoring components. Closed by design: these are the generic
 * dimensions core itself meters (setup/filesystem/nested/actor/product/feedback). A
 * product-specific scorecard does NOT extend this enum, so adopters' nouns stay out of core. It
 * ships as a thin in-repo extension that emits a namespaced `RunAdapterScore` via the lane's
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
     * The device preset as DECLARED by the lab, present only when it differs from `requested`
     * because the rendered width was floored to MIN_DESKTOP_RENDER_WIDTH.
     *
     * Without this, a floored run is indistinguishable from a faithful one: `verified` compares
     * the floored number with itself and reports a match, so a reader of the bundle sees
     * requested 500 / verified 500 and reasonably concludes a 500-wide preset was asked for. A
     * `mobile` (414) and a `small-mobile` (360) seat both render at 500 and look identical here.
     * When this field is set, the preset width did NOT render; see #221.
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
   * Mobile fidelity beyond viewport size (#221), present only when the lab asked for it. `requested`
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
     * Page targets the participant drove AFTER the launch page (a link that opened in a new tab)
     * whose own read-back reported the requested viewport width (#623). Absent when the
     * participant never left the launch tab; a later tab that did NOT report the width is a lane
     * warning instead.
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

/** The original participant-facing assignment, before runtime access/coordination details. */
export interface RunParticipantAssignment {
  mission: string;
  focus?: string;
  tasks?: Array<{ id: string; goal: string }>;
}

export interface RunStream {
  id: string;
  simId: string;
  /** Adapter-owned lane id for fan-out / target-swarm runs. Safe categorical metadata only. */
  laneId?: string;
  /** Adapter-owned actor class for grouping lanes, e.g. viewer/reviewer/admin. */
  actorType?: string;
  /** Adapter-owned product surface label for grouping lanes without parsing URLs. */
  surface?: string;
  /** Adapter-owned scenario/case grouping label. */
  caseGroup?: string;
  /** Authored/default mission and lane focus, redacted before persistence. Missing on older
   * bundles and uninstrumented routes; never reconstructed from study context or narration. */
  assignment?: RunParticipantAssignment;
  kind: RunStreamKind;
  label: string;
  status: RunSimulationStatus;
  transport: "snapshot" | "polling" | "sse" | "pty" | "app-server";
  updatedAt: string;
  url?: string;
  embed?: {
    kind: "iframe" | "terminal" | "screenshot" | "placeholder";
    url?: string;
    title?: string;
  };
  /** Set by the attached watch server when the lane's sandbox is gone: the injected live URL
   *  would render a provider error page, so viewers fall back to recorded evidence. Runtime-only
   *  and never persisted into bundles; declared here because the served observer-data carries it
   *  and the client is typed against this contract. */
  liveEnded?: boolean;
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
  /** Truthful screen/window/viewport evidence for hosted desktop browser lanes. */
  desktopGeometry?: RunDesktopGeometry;
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
  // Populated alongside the raw `codex` evidence; carries persona.traitsApplied.
  actor?: ActorTrace;
  /**
   * Mid-run partial actor evidence (#441): the redacted trace items recorded SO FAR,
   * flushed while a live lane is still running so the attached Observer's timeline can
   * grow. Deliberately NOT an ActorTrace — a running lane has no honest status,
   * completionReason, or completedAt, and this shape cannot claim them. Present ONLY on
   * `inProgress` bundles; the final write replaces it with the real `actor` and never
   * carries it.
   */
  liveActor?: {
    schema: "humanish.live-actor.v1";
    executionProfile?: ActorTrace["executionProfile"];
    providerRequests?: ActorTrace["providerRequests"];
    historyTurnsOmitted?: number;
    tokenUsage?: ActorTrace["tokenUsage"];
    estimatedCost?: ActorTrace["estimatedCost"];
    ids?: ActorTrace["ids"];
    /** When this flush was written (ISO-8601). */
    updatedAt: string;
    items: ActorTraceItem[];
  };
  completion?: RunStreamCompletion;
  recording?: RunDesktopRecording;
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
