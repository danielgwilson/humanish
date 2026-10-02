import { summarizeAffordanceUse } from "../../affordance.js";
import {
  ACTOR_TRACE_SCHEMA,
  type ActorCompletionReason,
  type ActorStatus,
  type ActorTrace,
  type ActorTraceItem,
  type ActorTraceItemKind,
} from "../../contract.js";
import type { Stop } from "./ending.js";
import type { LoopSession } from "./session.js";
import type { CuaLoopResult } from "./types.js";

// The session's trace: the recorder every item passes through while the loop runs, and the
// projection of the finished session onto its CuaLoopResult and public-safe ActorTrace.

/** A trace item's fields after its id and kind, before the recorder stamps its time. */
export type TraceBody = Omit<ActorTraceItem, "id" | "kind" | "at">;

/** An item to record later; its body is built only after its id is allocated. */
export interface Evidence {
  readonly kind: ActorTraceItemKind;
  readonly body: () => TraceBody;
}

export function notice(status: string, title: string, text: string): TraceBody {
  return { lifecycle: "completed", status, title, text };
}

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

  // The single recording choke point (#441): every trace item is stamped `at` from the
  // loop's injected clock as it is recorded, so timed playback reads recorded facts
  // (deterministic in tests via the injected `now`). The id is allocated before the body is
  // built, so a body that fails to build (a redaction error) still consumes its id.
  record(kind: ActorTraceItemKind, body: () => TraceBody): string {
    const id = `${kind}-${(this.seq += 1).toString().padStart(3, "0")}`;
    this.items.push({ id, kind, ...body(), at: new Date(this.now()).toISOString() });
    return id;
  }

  bump(key: keyof LoopCounts): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }
}

/** Exported so the participant-vs-harness distinction is pinned directly, not inferred from a run. */
export function statusForCompletionReason(reason: ActorCompletionReason): ActorStatus {
  switch (reason) {
    case "goal_satisfied":
    case "turn_completed": // turn_completed is a Codex reason; this loop emits goal_satisfied
      return "passed";
    // A session that ran out of time or budget did not reach its goal, whatever it achieved along
    // the way. Calling that `passed` is how a truncated study came to be reported as a green one —
    // and why "raise the timeout" kept landing on the operator instead of on the tool. This switch
    // is exhaustive with no default, so a new completion reason forces a compile error here.
    case "budget_reached":
      return "incomplete";
    case "timed_out":
      return "timed_out";
    case "blocked_approval":
      return "blocked";
    // A participant who stopped trying is the single most valuable thing a usability study
    // produces. Recording it as `failed` said the instrument broke, which is a different claim and
    // a false one — see docs/principles/three-roles.md.
    case "gave_up":
      return "abandoned";
    // Only the harness failing is a harness failure.
    case "actor_error":
    case "step_failed": // step_failed is the scripted-browser route's reason; this loop never emits it
    case "harness_error":
      return "failed";
  }
}

export function loopResult(
  session: LoopSession,
  stop: Stop,
  debrief: ActorTrace["debrief"],
): CuaLoopResult {
  const { provider, settings, trace: recorder, usage } = session;
  const { completionReason, reason, stopCause } = stop;
  const completedAtMs = session.now();
  const status = statusForCompletionReason(completionReason);
  const ids: ActorTrace["ids"] = {};
  if (provider.version !== undefined) ids.model = provider.version;
  // responseId is provider-authored and opaque; redact for defense-in-depth.
  if (session.lastResponseId !== undefined)
    ids.turnId = settings.redaction.redactText(session.lastResponseId);

  const { counts } = recorder;
  const screenshotNote = !(counts.screenshots > 0)
    ? "no screenshots captured"
    : session.redactScreenshots
      ? `${counts.screenshots} screenshot(s) redacted to blurred thumbnails via RedactionHooks`
      : `${counts.screenshots} full-fidelity screenshot(s) retained for local use — NOT redacted for publishing; set redactScreenshots to blur a share-as-is bundle`;
  // Self-describing artifact (invariant 6): when any observation carried structured app state,
  // the trace says how the loop handled it: it fed progress and task checks and was not written to
  // the trace. The appState itself never appears in this bundle.
  const notes = session.observedAppState
    ? `${screenshotNote}. App state was observed each turn to drive progress detection (a state-driven executor) and was NOT written to the trace — it is a runtime-only progress input, never persisted as evidence in this slice.`
    : screenshotNote;
  const tokenUsage = usage.tokenUsage();

  const trace: ActorTrace = {
    schema: ACTOR_TRACE_SCHEMA,
    provider: provider.id,
    ...usage.liveMetadata(),
    ...(provider.version === undefined ? {} : { providerVersion: provider.version }),
    protocol: "cua-loop",
    lane: "computer-use",
    persona: settings.persona,
    redaction: {
      status: "passed",
      screenshots: !(counts.screenshots > 0)
        ? "n/a"
        : session.redactScreenshots
          ? "blurred"
          : "raw",
      notes,
    },
    startedAt: new Date(session.startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - session.startedAtMs,
    status,
    completionReason,
    ...(stopCause === undefined ? {} : { stopCause }),
    reason,
    ids,
    ...(provider.modelSettings === undefined
      ? {}
      : {
          modelSettings: {
            reasoningEffort: provider.modelSettings.reasoningEffort,
            ...(provider.modelSettings.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: provider.modelSettings.maxOutputTokens }),
          },
        }),
    counts,
    items: recorder.items,
    ...(session.actionHistory.affordances.length > 0
      ? { affordanceUse: summarizeAffordanceUse(session.actionHistory.affordances) }
      : {}),
    ...(session.declaredOutcome === undefined ? {} : { declaredOutcome: session.declaredOutcome }),
    ...(debrief === undefined ? {} : { debrief }),
    ...(usage.interactionUsageIncomplete(session.capDeclared)
      ? { interactionUsageIncomplete: true as const }
      : {}),
    // The funnel is present exactly when a protocol was declared — including a session that ended
    // on turn 0, whose funnel honestly reads 0/N. No tasks declared means no funnel, not an empty one.
    ...(session.taskTracker === undefined ? {} : { taskFunnel: session.taskTracker.funnel() }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    capabilities: provider.capabilities,
  };

  return { status, completionReason, reason, trace };
}
