import type { ActorTraceItem, ParticipantDeclaredOutcome } from "../../contract.js";
import type { AffordanceObservation } from "../../affordance.js";
import { TaskTracker } from "../../../lab/tasks.js";
import type { CuaLoopOptions, CuaProvider, CuaExecutor, CuaSafetyCheck } from "./types.js";
import { UsageLedger } from "./usage.js";

// The state one loop session shares across its phases: resolved options, the session clock, the
// trace being recorded, the usage ledger, and what the participant has done so far.

// Waiting is a legitimate strategy, not idleness. A persona told to sign up and verify by email
// polls its inbox — screenshot, wait, screenshot, wait — and at 6 steps that ended the session as
// `gave_up`/`failed` in well under a minute, before the mail could plausibly arrive. The concurrent
// shared-world route already overrode these to 80/40 for exactly this reason; the knowledge existed
// in the codebase and never reached the default every other route uses.
const DEFAULT_IDLE_STEPS = 24;
// The no-progress signal is much stronger since #383 (a stale frame alone no longer counts — the
// actor must also be repeating itself), so this needs less headroom than the raw idle count.
const DEFAULT_NO_PROGRESS_STEPS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 60_000;

/** A trace item before the recorder stamps its id and time. */
export type TraceDraft = Omit<ActorTraceItem, "id" | "at">;
export type ScreenshotRef = NonNullable<ActorTraceItem["screenshotRef"]>;

export type LoopCounts = {
  turns: number;
  actions: number;
  materialActions: number;
  screenshots: number;
  reasonings: number;
  messages: number;
  idleTurns: number;
  noProgressTurns: number;
  debriefCalls?: number;
};

export class TraceRecorder {
  readonly items: ActorTraceItem[] = [];
  readonly counts: LoopCounts = {
    turns: 0,
    actions: 0,
    materialActions: 0,
    screenshots: 0,
    reasonings: 0,
    messages: 0,
    idleTurns: 0,
    noProgressTurns: 0,
  };
  private seq = 0;

  constructor(private readonly now: () => number) {}

  // The ONE recording choke point (#441): every trace item is stamped `at` from the
  // loop's injected clock as it is recorded, so timed playback reads recorded facts
  // (deterministic in tests via the injected `now`).
  record(item: TraceDraft): string {
    const id = `${item.kind}-${(this.seq += 1).toString().padStart(3, "0")}`;
    this.items.push({ id, ...item, at: new Date(this.now()).toISOString() });
    return id;
  }

  notice(status: string, title: string, text: string): string {
    return this.record({ kind: "notice", lifecycle: "completed", status, title, text });
  }

  bump(key: keyof LoopCounts): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }
}

/** The participant's dispatched actions, as the backstop and failure notices describe them. */
export interface Activity {
  lastActionTitle: string | undefined;
  lastMaterialActionTitle: string | undefined;
  readonly recentActionTitles: string[];
  // Affordance classification (#369): WHICH route the actor took, recorded per dispatched action.
  // Collected here because the typed text exists only at dispatch — describeCuaAction deliberately
  // destroys it before it can reach the trace. Only the CLASS (and a scheme-shaped signal) is kept.
  readonly affordances: AffordanceObservation[];
  /** The loop stopped waiting on an action before the executor acknowledged it. */
  interruptedActionOutcome: boolean;
}

export class LoopSession {
  readonly provider: CuaProvider;
  readonly executor: CuaExecutor;
  readonly signal: AbortSignal | undefined;
  readonly now: () => number;
  readonly startedAtMs: number;
  readonly timeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly observationTimeoutMs: number;
  readonly idleSteps: number;
  readonly noProgressSteps: number;
  readonly acknowledgeSafetyChecks: (checks: CuaSafetyCheck[]) => CuaSafetyCheck[] | null;
  readonly redactScreenshots: boolean;
  readonly writeScreenshot: (name: string, bytes: Buffer) => Promise<string>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Strict capped routes stop when a request's usage is unavailable. */
  readonly requiresUsage: boolean;
  readonly trace: TraceRecorder;
  readonly usage: UsageLedger;
  // The funnel is recorded, never consulted: task completion does not steer the loop.
  readonly taskTracker: TaskTracker | undefined;
  readonly activity: Activity = {
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
  // Whether any observation this run surfaced structured appState (a non-vision/state executor).
  // RUNTIME-ONLY signal: used solely to self-describe in redaction.notes that app state drove
  // progress detection and was NOT written to the trace — the appState itself never persists.
  observedAppState = false;
  declaredOutcome: ParticipantDeclaredOutcome | undefined;
  private readonly scrubText: (text: string) => string;

  constructor(readonly options: CuaLoopOptions) {
    this.provider = options.provider;
    this.executor = options.executor;
    this.signal = options.signal;
    this.now = options.now;
    this.timeoutMs = options.timeoutMs;
    this.idleSteps = options.idleSteps ?? DEFAULT_IDLE_STEPS;
    this.noProgressSteps = options.noProgressSteps ?? DEFAULT_NO_PROGRESS_STEPS;
    this.acknowledgeSafetyChecks = options.acknowledgeSafetyChecks ?? (() => null);
    this.redactScreenshots = options.redactScreenshots ?? false;
    this.scrubText = options.scrubText ?? ((text) => text);
    this.writeScreenshot = options.writeScreenshot ?? (async (name) => `screenshots/${name}`);
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.requiresUsage =
      (options.requireReportedUsageForSpendCap ?? false) &&
      (options.maxUsd !== undefined || options.overRunBudget !== undefined);
    this.startedAtMs = options.now();
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.observationTimeoutMs = options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
    this.trace = new TraceRecorder(options.now);
    this.usage = new UsageLedger(options.provider);
    this.taskTracker =
      options.tasks !== undefined && options.tasks.length > 0
        ? new TaskTracker(options.tasks)
        : undefined;
  }

  remaining(): number {
    return this.timeoutMs - (this.now() - this.startedAtMs);
  }

  // Model-authored narration: literal-scrub known provisioned values, THEN pattern-redact.
  // A value the model transcribes (a DB password it read on screen) has no shape, so redactText
  // alone cannot catch it — the lab's scrubKnownValues, injected as scrubText, closes that.
  redactNarration(text: string): string {
    return this.options.redaction.redactText(this.scrubText(text));
  }

  /** Hand a watcher the trace so far with the running usage, without waiting on it. */
  flush(): void {
    const { onTrace } = this.options;
    onTrace?.(this.trace.items.slice(), this.usage.running(), this.usage.liveMetadata());
  }
}
