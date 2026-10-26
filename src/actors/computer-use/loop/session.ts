import type {
  ActorStopCause,
  ActorTraceItem,
  ParticipantDeclaredOutcome,
  ParticipantImpressions,
  TracePage,
} from "../../contract.js";
import type { AffordanceObservation } from "../../affordance.js";
import { traceRedaction } from "../../../evidence/trace-page.js";
import { TaskTracker } from "../../../study/tasks.js";
import type { DebriefTrigger, Stop } from "./ending.js";
import { StreakRecord } from "./streak.js";
import { notice, TraceRecorder } from "./trace.js";
import type { CuaExecutor, CuaProvider, CuaSafetyCheck, CuaTurn, LoopRunOptions } from "./types.js";
import { UsageLedger } from "./usage.js";
import { resolveWaitSettings, type WaitSettings } from "../wait.js";

// The state one loop session shares across its phases: the options as read at entry, the session
// clock, the trace being recorded, the usage ledger, and what the participant has done so far.

// Waiting is a legitimate strategy. A persona verifying a sign-up by email polls its inbox
// (screenshot, wait, screenshot, wait), and a short idle limit ends that session as gave_up before
// the mail can arrive.
const DEFAULT_IDLE_STEPS = 24;
// A no-progress turn also needs a repeated action, so this needs less headroom than the
// idle limit.
const DEFAULT_NO_PROGRESS_STEPS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 60_000;

export type ScreenshotRef = NonNullable<ActorTraceItem["screenshotRef"]>;

/**
 * The options with no default, read once at entry and passed through. Defaulted options and
 * wrapped callbacks are fields on LoopSession instead. Callers destructure hooks to call them.
 */
export type LoopSettings = {
  readonly [
    K in
      | "instructions"
      | "persona"
      | "redaction"
      | "stopWhen"
      | "dwell"
      | "clock"
      | "tasks"
      | "maxUsd"
      | "overRunBudget"
      | "estimateTurnCostUsd"
      | "onObservedUrl"
      | "onMessage"
      | "onScreenshot"
      | "onTrace"
      | "recordPages"
      | "onCheckpoint"
  ]: LoopRunOptions[K];
};

/** The participant's dispatched actions, as the backstop and failure notices describe them. */
export interface ActionHistory {
  lastActionTitle: string | undefined;
  lastMaterialActionTitle: string | undefined;
  readonly recentActionTitles: string[];
  // Affordance classification: which route the actor took, recorded per dispatched action.
  // Collected here because the typed text exists only at dispatch; describeCuaAction deliberately
  // destroys it before it can reach the trace. Only the class (and a scheme-shaped signal) is kept.
  readonly affordances: AffordanceObservation[];
  /** The loop stopped waiting on an action before the executor acknowledged it. */
  interruptedActionOutcome: boolean;
}

/**
 * One loop session's shared state: the options as read at entry, the clock and deadline, the trace
 * recorder, the usage ledger, the participant's action history, and the stop being concluded.
 */
export class LoopSession {
  readonly settings: LoopSettings;
  readonly provider: CuaProvider;
  readonly executor: CuaExecutor;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly idleSteps: number;
  readonly noProgressSteps: number;
  /** How long each wait lasts: the study's wait fields or their defaults. */
  readonly waits: WaitSettings;
  readonly redactScreenshots: boolean;
  // Injected functions are wrapped so they are called without a receiver, as plain functions.
  readonly now: () => number;
  readonly acknowledgeSafetyChecks: (checks: CuaSafetyCheck[]) => CuaSafetyCheck[] | null;
  readonly writeScreenshot: (name: string, bytes: Buffer) => Promise<string>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Strict capped routes stop when a request's usage is unavailable. */
  readonly requiresUsage: boolean;
  /**
   * A dollar cap or study budget is declared. Its estimate is built from reported usage, so a
   * request whose usage is unknown and unbounded stops the session before the next one.
   */
  readonly capDeclared: boolean;
  readonly startedAtMs: number;
  readonly turnTimeoutMs: number;
  readonly observationTimeoutMs: number;
  readonly trace: TraceRecorder;
  readonly usage: UsageLedger;
  // The funnel is recorded, never consulted: task completion does not steer the loop.
  readonly taskTracker: TaskTracker | undefined;
  /** The no-progress streak a held participant is in, for the trace. */
  readonly streak = new StreakRecord(this);
  readonly actionHistory: ActionHistory = {
    lastActionTitle: undefined,
    lastMaterialActionTitle: undefined,
    recentActionTitles: [],
    affordances: [],
    interruptedActionOutcome: false,
  };
  /** What the loop was doing, for failure notices. */
  phase = "initializing computer-use loop";
  lastScreenshotRef: ScreenshotRef | undefined;
  lastResponseId: string | undefined;
  // Whether any observation carried appState. trace.ts states it in redaction.notes; the appState
  // itself is never persisted.
  observedAppState = false;
  /** The page of the session's last observation; undefined when that observation read no URL. */
  finalPage: TracePage | undefined;
  declaredOutcome: ParticipantDeclaredOutcome | undefined;
  /** Set by a structured stop; the debrief follows it even if the session then failed. */
  debriefTrigger: DebriefTrigger | undefined;
  /** Set by the participant's own final account or by its closing report. */
  impressions: ParticipantImpressions | undefined;
  private stopCause: ActorStopCause | undefined;
  private readonly redactTrace: (text: string) => string;

  constructor(options: LoopRunOptions) {
    // Read once, in this order: a caller mutating its options object mid-run changes nothing.
    const {
      instructions,
      provider,
      executor,
      persona,
      redaction,
      timeoutMs,
      now,
      signal,
      idleSteps = DEFAULT_IDLE_STEPS,
      noProgressSteps = DEFAULT_NO_PROGRESS_STEPS,
      maxWaitMs,
      idleWaitMs,
      acknowledgeSafetyChecks = () => null,
      redactScreenshots = false,
      scrubText = (text) => text,
      writeScreenshot = async (name) => `screenshots/${name}`,
      stopWhen,
      dwell,
      clock,
      sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      tasks,
      maxUsd,
      overRunBudget,
      estimateTurnCostUsd,
      requireReportedUsageForSpendCap = false,
      onObservedUrl,
      onMessage,
      onScreenshot,
      onTrace,
      recordPages,
      onCheckpoint,
    } = options;
    this.settings = {
      instructions,
      persona,
      redaction,
      stopWhen,
      dwell,
      clock,
      tasks,
      maxUsd,
      overRunBudget,
      estimateTurnCostUsd,
      onObservedUrl,
      onMessage,
      onScreenshot,
      onTrace,
      recordPages,
      onCheckpoint,
    };
    this.provider = provider;
    this.executor = executor;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.idleSteps = idleSteps;
    this.noProgressSteps = noProgressSteps;
    this.waits = resolveWaitSettings({
      maxWaitMs,
      idleWaitMs,
      speechEnabled: executor.speechEnabled === true,
    });
    this.redactScreenshots = redactScreenshots;
    this.now = () => now();
    this.acknowledgeSafetyChecks = (checks) => acknowledgeSafetyChecks(checks);
    // The run's scrubKnownValues comes in as scrubText.
    this.redactTrace = traceRedaction(
      (text) => scrubText(text),
      (text) => redaction.redactText(text),
    );
    this.writeScreenshot = (name, bytes) => writeScreenshot(name, bytes);
    this.sleep = (ms) => sleep(ms);
    this.capDeclared = maxUsd !== undefined || overRunBudget !== undefined;
    this.requiresUsage = requireReportedUsageForSpendCap && this.capDeclared;
    this.startedAtMs = now();
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.observationTimeoutMs = options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
    this.trace = new TraceRecorder(this.now);
    this.usage = new UsageLedger(provider);
    this.taskTracker = tasks !== undefined && tasks.length > 0 ? new TaskTracker(tasks) : undefined;
  }

  remaining(): number {
    return this.timeoutMs - (this.now() - this.startedAtMs);
  }

  /** Model-authored narration and recorded pages, through traceRedaction. */
  redactNarration(text: string): string {
    return this.redactTrace(text);
  }

  /** Book a reply's usage and record, as warnings, the notices its provider attached to it. */
  recordReply(turn: CuaTurn, kind: "interaction" | "debrief"): void {
    this.usage.record(turn, kind);
    for (const { title, text } of turn.notices ?? [])
      this.trace.record("notice", () => notice("warn", title, this.redactNarration(text)));
  }

  /** Hand a watcher the trace so far with the running usage, without waiting on it. */
  flush(): void {
    const { onTrace } = this.settings;
    onTrace?.(this.trace.items.slice(), this.usage.running(), this.usage.liveMetadata());
  }

  /**
   * Commit a stop where it is decided: its debrief trigger and stop cause first, then its trace
   * evidence. A failure while recording the evidence ends the session as an error that keeps
   * both. Returns the stop without evidence, so concluding it again records nothing.
   */
  conclude(stop: Stop): Stop {
    this.debriefTrigger = stop.debriefTrigger ?? this.debriefTrigger;
    this.stopCause = stop.stopCause ?? this.stopCause;
    if (stop.evidence !== undefined) this.trace.record(stop.evidence.kind, stop.evidence.body);
    return {
      completionReason: stop.completionReason,
      reason: stop.reason,
      ...(this.stopCause === undefined ? {} : { stopCause: this.stopCause }),
    };
  }
}
