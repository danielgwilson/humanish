// The model side of one computer-use participant: the provider a local agent brings, the session options
// the loop runs with, the study's shared spend ledger, the provider cleanup, and the checks on the
// finished session. The desktop side stays with the participant runner.

import type {
  CuaExecutor,
  CuaLiveMetadata,
  CuaLoopResult,
  CuaProvider,
} from "../../actors/computer-use/loop.js";
import type { ActorConversation, ActorTokenUsage, ActorTraceItem } from "../../actors/contract.js";
import type { CuaActorSessionOptions } from "../../actors/computer-use/actor.js";
import type { ParticipantProviderOptions } from "../../actors/computer-use/providers.js";
import { startClaudeSession } from "../../actors/local-agent/claude-session.js";
import { createLocalAgentProvider } from "../../actors/local-agent/cli.js";
import { pricedModel } from "../../study/plan-base.js";
import { estimateActorCostForExecution, round6 } from "../../run/pricing.js";
import { redactText } from "../../evidence/redaction.js";
import {
  createRestrictedCodexParticipant,
  type ParticipantProviderCloseResult,
} from "../../actors/codex/restricted-participant.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import { withInboxMission } from "./participant-prompt.js";
import {
  resolveSelfReportedBlocker,
  resolveSelfReportedFriction,
  sessionEnding,
} from "./self-report.js";
import { hollowCompletion } from "../../run/judge.js";
import type { ParticipantModelDeps, CuaRunBudget, DesktopParticipantRun } from "./types.js";
import type { ReadyParticipantDesktop } from "./participant-desktop.js";

// Caller providers backed by a native Codex session (the local study's), with their close report.
const closeReports = new WeakMap<CuaProvider, () => Promise<ParticipantProviderCloseResult>>();

/**
 * Registers a caller's provider as backed by a native Codex session: the participant runner reads the session's
 * run warnings and a refusal no request reported from `report` when it closes the provider.
 */
export function withCloseReport<T extends CuaProvider>(
  provider: T,
  report: () => Promise<ParticipantProviderCloseResult>,
): T {
  closeReports.set(provider, report);
  return provider;
}

/** The model a participant brings besides the default API client, and the handles its cleanup needs. */
export interface ParticipantModel {
  provider?: CuaProvider;
  codexParticipant?: ReturnType<typeof createRestrictedCodexParticipant>;
  claudeSession?: Awaited<ReturnType<typeof startClaudeSession>>;
}

/** Starts the participant's model: a caller's provider, the operator's Codex, a Claude session, or none. */
export async function startParticipantModel(
  spec: DesktopParticipantRun,
  deps: ParticipantModelDeps,
  executor: CuaExecutor,
): Promise<ParticipantModel> {
  const { env, brain } = deps;
  if (deps.createProvider) {
    const participant = {
      id: spec.planned.id,
      index: spec.planned.index,
      count: deps.participantCount,
    };
    return { provider: await deps.createProvider(participant, executor) };
  }
  const localAgent = brain.kind === "local-agent" ? brain.agent : undefined;
  if (localAgent === "codex") {
    // Hosted local-agent studies use the same native participant engine as local desktops.
    // Operator auth deliberately retains the operator's Codex home, config and supported auth
    // stores instead of applying the isolated restricted-account profile used by local studies.
    const codexParticipant = createRestrictedCodexParticipant({
      authMode: "operator",
      ...(spec.planned.limits.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: spec.planned.limits.reasoningEffort }),
      ...(brain.declaredModel === undefined ? {} : { model: brain.declaredModel }),
      ...(executor.speechEnabled === true ? { speechEnabled: true } : {}),
      ...(spec.planned.limits.maxWaitMs === undefined
        ? {}
        : { maxWaitMs: spec.planned.limits.maxWaitMs }),
      ...(spec.planned.limits.idleWaitMs === undefined
        ? {}
        : { idleWaitMs: spec.planned.limits.idleWaitMs }),
      session: { env },
    });
    return { provider: codexParticipant.provider, codexParticipant };
  }
  if (localAgent === "claude") {
    // One session for the whole run, like the codex thread above. The one-shot
    // provider (createLocalAgentProvider) spawned `claude -p` per turn, and every turn
    // started with no memory of the last. HUMANISH_LOCAL_AGENT_ONE_SHOT=1 keeps that path
    // reachable as a measurement switch: MemTrapBench (2026-08) reports memory frameworks
    // degrading agent performance by 10-40% on some tasks, so "remembers" has to be measured
    // against "does not" on the same study, not assumed. The trace records which one ran.
    const oneShot =
      env.HUMANISH_LOCAL_AGENT_ONE_SHOT !== undefined &&
      env.HUMANISH_LOCAL_AGENT_ONE_SHOT !== "" &&
      env.HUMANISH_LOCAL_AGENT_ONE_SHOT !== "0";
    if (oneShot) {
      return {
        provider: createLocalAgentProvider({
          agent: "claude",
          ...(spec.planned.limits.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: spec.planned.limits.reasoningEffort }),
          ...(brain.declaredModel === undefined ? {} : { model: brain.declaredModel }),
          env,
        }),
      };
    }
    const claudeSession = await startClaudeSession({
      env,
      ...(spec.planned.limits.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: spec.planned.limits.reasoningEffort }),
      ...(brain.declaredModel === undefined ? {} : { model: brain.declaredModel }),
    });
    return { provider: claudeSession.provider, claudeSession };
  }
  return {};
}

/** The options the participant's session runs with: prompt, model settings, spend caps and callbacks. */
export function participantSessionOptions(
  spec: DesktopParticipantRun,
  deps: ParticipantModelDeps,
  ready: ReadyParticipantDesktop,
  provider: CuaProvider | undefined,
  writeScreenshot: NonNullable<CuaActorSessionOptions["writeScreenshot"]>,
): CuaActorSessionOptions {
  const { executor, inbox, onCheckpoint } = ready;
  // The fail-closed spend cap (caps.maxUsd) is wired into the loop as maxUsd + an
  // injected pure per-turn estimator keyed on the resolved model. Preflight already refused a
  // cap on an unpriced model, so the estimate is measurable whenever a cap is in force. The
  // model id here matches provider.version (the provider resolves the default when unset).
  const capModelId = pricedModel(deps.brain);
  const maxUsd = deps.caps.maxUsd;
  return {
    instructions: inbox
      ? withInboxMission(spec, inbox.url, inbox.address, inbox.receiving).instructions
      : spec.instructions,
    persona: spec.persona,
    timeoutMs: deps.timeoutMs,
    ...participantClock(spec.planned.limits.timeZone, deps),
    // The brain is either a keyed API client or a CLI the operator is already signed in to.
    // Everything below this line (loop, executor, trace, affordances) is identical either
    // way, which is what makes a local-agent run comparable to an API one.
    ...(provider === undefined ? {} : { provider: provider }),
    ...(deps.brain.kind === "provider-key"
      ? {
          participant: {
            vendor: deps.brain.vendor,
            options: participantProviderOptions(spec, deps),
          },
        }
      : {}),
    ...(maxUsd === undefined
      ? {}
      : {
          maxUsd,
          estimateTurnCostUsd: (usage: ActorTokenUsage): number | null =>
            estimateActorCostForExecution(
              usage,
              provider?.version ?? capModelId,
              provider?.executionProfile,
            ).estimatedCostUsd,
        }),
    executor,
    redactScreenshots: deps.redactScreenshots,
    scrubText: deps.scrubKnownValues,
    writeScreenshot,
    ...(spec.backstop?.idleSteps === undefined ? {} : { idleSteps: spec.backstop.idleSteps }),
    ...(spec.backstop?.noProgressSteps === undefined
      ? {}
      : { noProgressSteps: spec.backstop.noProgressSteps }),
    ...(spec.planned.limits.stopWhen === undefined
      ? {}
      : { stopWhen: spec.planned.limits.stopWhen }),
    ...(spec.planned.limits.dwell === undefined ? {} : { dwell: spec.planned.limits.dwell }),
    ...(spec.planned.limits.maxWaitMs === undefined
      ? {}
      : { maxWaitMs: spec.planned.limits.maxWaitMs }),
    ...(spec.planned.limits.idleWaitMs === undefined
      ? {}
      : { idleWaitMs: spec.planned.limits.idleWaitMs }),
    ...(spec.planned.tasks === undefined ? {} : { tasks: spec.planned.tasks }),
    // The study budget: this participant notes its own running estimate on the shared
    // ledger and stops when the run total crosses the cap, independent of the per-participant
    // maxUsd above.
    ...(deps.runBudget === undefined
      ? {}
      : {
          overRunBudget: (usage: ActorTokenUsage): string | null => {
            const estimate = estimateActorCostForExecution(
              usage,
              provider?.version ?? capModelId,
              provider?.executionProfile,
            ).estimatedCostUsd;
            deps.runBudget!.note(spec.planned.id, estimate);
            const crossed = deps.runBudget!.crossed();
            return crossed === undefined
              ? null
              : `study budget reached: ${crossed}; the study's participants stop before their next model request`;
          },
        }),
    ...(onCheckpoint === undefined ? {} : { onCheckpoint }),
    ...(deps.onObservedUrl === undefined ? {} : { onObservedUrl: deps.onObservedUrl }),
    ...(deps.onMessage === undefined ? {} : { onMessage: deps.onMessage }),
    ...(deps.onScreenshot === undefined ? {} : { onScreenshot: deps.onScreenshot }),
    ...(deps.onTrace === undefined
      ? {}
      : {
          // Forwards the running usage as well: the participant runner is where both are known, and usage
          // without it never reaches the flush, which is how the live cost stayed unknown.
          onTrace: (
            items: readonly ActorTraceItem[],
            usage: ActorTokenUsage,
            metadata?: CuaLiveMetadata,
          ): void => deps.onTrace?.(spec.planned.id, items, usage, metadata),
        }),
  };
}

/**
 * What a provider-key participant's provider is built with. A model declared empty is left out, so
 * the provider runs its default while the spend is priced at the declared "" (pricedModel).
 */
function participantProviderOptions(
  spec: DesktopParticipantRun,
  deps: ParticipantModelDeps,
): ParticipantProviderOptions {
  const { limits } = spec.planned;
  return {
    apiKey: deps.participantApiKey,
    ...(deps.brain.declaredModel ? { model: deps.brain.declaredModel } : {}),
    // Per-participant, not per-actor: two participants at different efforts is the control this
    // exists for.
    ...(limits.reasoningEffort === undefined ? {} : { reasoningEffort: limits.reasoningEffort }),
    ...(limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: limits.maxOutputTokens }),
    ...(limits.serviceTier === undefined ? {} : { serviceTier: limits.serviceTier }),
  };
}

/**
 * Closes the participant's model, in the order it was opened. Returns true when a provider's cleanup is
 * unconfirmed; each failure also adds a warning.
 */
export async function closeParticipantModel(
  model: ParticipantModel,
  warnings: string[],
): Promise<{ unconfirmed: boolean; refusal: string | undefined }> {
  let unconfirmed = false;
  let refusal: string | undefined;
  try {
    if (model.codexParticipant === undefined) await model.provider?.close?.();
  } catch {
    warnings.push("Model provider cleanup is unconfirmed.");
    unconfirmed = true;
  }
  try {
    const cleanup = await model.codexParticipant?.close();
    warnings.push(...(cleanup?.warnings ?? []));
    refusal = cleanup?.refusal;
    if (cleanup?.status === "unconfirmed") {
      warnings.push("Model provider cleanup is unconfirmed.");
      unconfirmed = true;
    }
  } catch {
    warnings.push("Model provider cleanup is unconfirmed.");
    unconfirmed = true;
  }
  const report =
    model.codexParticipant === undefined && model.provider !== undefined
      ? closeReports.get(model.provider)
      : undefined;
  if (report) {
    // The provider's own close reported cleanup above; this reads what its session found.
    try {
      const found = await report();
      warnings.push(...(found.warnings ?? []));
      refusal ??= found.refusal;
    } catch {
      /* Cleanup was already reported through the provider's close. */
    }
  }
  try {
    const closed = await model.claudeSession?.close();
    refusal ??= closed?.refusal;
  } catch {
    warnings.push("Claude session cleanup failed; desktop cleanup will still run.");
  }
  return { unconfirmed, refusal };
}

/** Prices the finished session's tokens onto its trace, writes the trace, and warns on raw screenshots. */
export async function recordParticipantTrace(
  spec: DesktopParticipantRun,
  deps: ParticipantModelDeps,
  session: CuaLoopResult,
  warnings: string[],
): Promise<void> {
  // Per-participant model-token cost estimate, attached to the trace before it is persisted (the model
  // id is authoritative here: provider.version). Kept at the study boundary so the pure loop
  // never depends on the operator rate table. estimateActorCost declares absent (null) for an
  // unknown rate / missing usage rather than guessing.
  session.trace.estimatedCost = estimateActorCostForExecution(
    session.trace.tokenUsage,
    session.trace.ids.model,
    session.trace.executionProfile,
  );
  await writeContainedOutputFile(
    deps.artifactRoot,
    spec.traceArtifactPath,
    `${JSON.stringify(session.trace, null, 2)}\n`,
    "utf8",
  );
  const conversation = session.trace.conversation;
  const carried = conversation === undefined ? undefined : explicitContextWarning(conversation);
  if (carried !== undefined) warnings.push(carried);
  if (session.trace.redaction.screenshots === "raw") {
    warnings.push(
      "Screenshots are unblurred for local use: the bundle stays in the gitignored .humanish/ folder and nothing scans these pixels, so review them before sharing. Set policies.redactScreenshots: true to blur screenshots in a bundle you plan to share.",
    );
  }
}

/**
 * The run warning for a participant whose provider kept no conversation server-side although it
 * can, so humanish carried it on every request. It says why, and how many early turns became a
 * text summary. Undefined for a threaded session and for an API that never keeps a conversation:
 * there, carrying it is how every request works, and nothing was set or refused.
 */
export function explicitContextWarning(conversation: ActorConversation): string | undefined {
  if (conversation.mode !== "explicit_context" || conversation.explicitReason === "stateless_api")
    return undefined;
  const answer =
    conversation.rejection === "stored_item"
      ? " (a stored item the request referenced was not found)"
      : conversation.rejection === "previous_response"
        ? " (the previous response was refused or not found)"
        : "";
  const why =
    conversation.explicitReason === "zdr_rejection"
      ? `The OpenAI organization rejected server-side conversation state (zero data retention)${
          conversation.switchedAtRequest === undefined
            ? ""
            : ` on request ${conversation.switchedAtRequest}`
        }${answer}`
      : "zeroDataRetention is set";
  const summarized =
    conversation.summarizedTurns === 0
      ? ""
      : ` To stay within its token budget it summarized the ${conversation.summarizedTurns} oldest turns as text and dropped their screenshots.`;
  return `${why}, so humanish carried this participant's conversation itself (explicit_context).${summarized} The trace's conversation record has each request's carried context.`;
}

/** The checks that keep a goal_satisfied session from counting as a pass, with their warnings. */
export function judgeParticipantSession(
  session: CuaLoopResult | undefined,
  deps: ParticipantModelDeps,
  warnings: string[],
): { noEngagement: boolean; selfReportedBlocker: boolean; reportedFriction: boolean } {
  const noEngagement = session !== undefined && hollowCompletion(sessionEnding(session));
  if (noEngagement) {
    warnings.push(
      "The participant returned goal_satisfied with no actions and no messages, so it likely saw a blank or loading screen and stopped. This does not count as a pass. Check the screenshot, and raise execution.timeoutMs or confirm the app had rendered before the first turn.",
    );
  }

  const blockerReason = resolveSelfReportedBlocker(session);
  const selfReportedBlocker = blockerReason !== undefined;
  const reportedFriction = resolveSelfReportedFriction(session) !== undefined;
  if (selfReportedBlocker) {
    warnings.push(
      `The participant returned goal_satisfied, but its final message describes a blocker or asks for missing instructions, so this does not count as a pass: ${redactText(deps.scrubKnownValues(blockerReason))}`,
    );
  }
  return { noEngagement, selfReportedBlocker, reportedFriction };
}

/**
 * caps.maxUsd is enforced inside each participant's loop independently, so N participants can
 * spend up to N × maxUsd before any of them stops, while the run cost summary reports the larger
 * aggregate. The warning names that ceiling, unless the study declared a shared maxTotalUsd budget.
 * `capped` names what the cap counts: shared world says model spend, because the external-public
 * plane's lobby-code reads are not counted against it.
 */
export function participantCapWarning(
  caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number },
  participantCount: number,
  capped = "each participant",
): string | undefined {
  const capUsd = caps.maxUsd;
  if (capUsd === undefined || participantCount <= 1) return undefined;
  if (caps.maxTotalUsd !== undefined) return undefined;
  return `caps.maxUsd ($${capUsd}) caps ${capped}, so ${participantCount} participants may spend up to ${participantCount} × $${capUsd} (about $${round6(capUsd * participantCount)}) before any of them stops. Set caps.maxTotalUsd for one budget across the study.`;
}

export function makeCuaRunBudget(maxTotalUsd: number): CuaRunBudget {
  const participantEstimates = new Map<string, number>();
  const total = (): number => {
    let sum = 0;
    for (const value of participantEstimates.values()) sum += value;
    return sum;
  };
  return {
    maxTotalUsd,
    note(participantId, estimateUsd) {
      if (estimateUsd !== null) participantEstimates.set(participantId, estimateUsd);
      return total();
    },
    crossed() {
      const totalUsd = total();
      return totalUsd > maxTotalUsd
        ? `the run's estimated model spend $${round6(totalUsd)} crossed caps.maxTotalUsd=$${maxTotalUsd}`
        : undefined;
    },
  };
}

/**
 * The participant's clock: its time zone, and its end on the run's clock. A participant with an
 * end runs its session on the run's clock, so the end and the schedule read one clock. A cap
 * counts from here, where the session starts, so the desktop's setup does not use it.
 */
function participantClock(
  timeZone: string | undefined,
  deps: Pick<ParticipantModelDeps, "end" | "now">,
): Pick<CuaActorSessionOptions, "clock" | "now"> {
  const declared = deps.end;
  if (timeZone === undefined && declared === undefined) return {};
  const end =
    declared === undefined
      ? undefined
      : declared.kind === "session_cap"
        ? {
            atMs: deps.now() + declared.afterMs,
            windDownMs: declared.windDownMs,
            kind: declared.kind,
          }
        : { atMs: declared.atMs, windDownMs: declared.windDownMs };
  return {
    clock: {
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(end === undefined ? {} : { end }),
    },
    ...(end === undefined ? {} : { now: deps.now }),
  };
}
