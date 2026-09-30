import { summarizeAffordanceUse } from "../../affordance.js";
import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../../contract.js";
import { statusForCompletionReason, type Stop } from "./ending.js";
import type { LoopSession } from "./session.js";
import type { CuaLoopResult } from "./types.js";

// Projection of a finished loop session onto its CuaLoopResult and public-safe ActorTrace.

export function loopResult(
  session: LoopSession,
  stop: Stop,
  debrief: ActorTrace["debrief"],
): CuaLoopResult {
  const { provider, options, trace: recorder, usage } = session;
  const { completionReason, reason, stopCause } = stop;
  const completedAtMs = session.now();
  const status = statusForCompletionReason(completionReason);
  const ids: ActorTrace["ids"] = {};
  if (provider.version !== undefined) ids.model = provider.version;
  // responseId is provider-authored and opaque; redact for defense-in-depth.
  if (session.lastResponseId !== undefined)
    ids.turnId = options.redaction.redactText(session.lastResponseId);

  const { counts } = recorder;
  const screenshotNote = !(counts.screenshots > 0)
    ? "no screenshots captured"
    : session.redactScreenshots
      ? `${counts.screenshots} screenshot(s) redacted to blurred thumbnails via RedactionHooks`
      : `${counts.screenshots} full-fidelity screenshot(s) retained for local use — NOT redacted for publishing; set redactScreenshots to blur a share-as-is bundle`;
  // Self-describing artifact (invariant 6): when a non-vision executor surfaced structured app
  // state, the trace declares HOW it handled that surface — app state drove progress detection
  // each turn and was NOT written to the trace (it is a runtime-only progress input, like
  // stateSignature). The appState itself never appears anywhere in this bundle.
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
    persona: options.persona,
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
    ...(session.activity.affordances.length > 0
      ? { affordanceUse: summarizeAffordanceUse(session.activity.affordances) }
      : {}),
    ...(session.declaredOutcome === undefined ? {} : { declaredOutcome: session.declaredOutcome }),
    ...(debrief === undefined ? {} : { debrief }),
    ...(usage.interactionUsageIncomplete(session.requiresUsage)
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
