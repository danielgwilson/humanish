// The model side of one computer-use lane: the provider a local agent brings, the session options
// the loop runs with, the provider cleanup, and the checks on the finished session. The desktop
// side stays with the lane runner.

import type {
  CuaExecutor,
  CuaLiveMetadata,
  CuaLoopResult,
  CuaProvider,
} from "../../actors/computer-use/loop.js";
import type { ActorTokenUsage, ActorTraceItem } from "../../actors/contract.js";
import type { CuaActorSessionOptions } from "../../actors/computer-use/actor.js";
import { startClaudeSession } from "../../actors/local-agent/claude-session.js";
import { createLocalAgentProvider } from "../../actors/local-agent/cli.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { estimateActorCostForExecution, round6 } from "../../run/pricing.js";
import { redactText } from "../../evidence/redaction.js";
import { createRestrictedCodexParticipant } from "../../actors/codex/restricted-participant.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import { withInboxMission } from "./lane-plan.js";
import {
  resolveSelfReportedBlocker,
  resolveSelfReportedFriction,
  sessionEnding,
} from "./self-report.js";
import { hollowCompletion } from "../../run/judge.js";
import type { CuaLaneDeps, DesktopParticipantRun } from "./types.js";
import type { ReadyCuaDesktop } from "./desktop-lane.js";
import { laneSpecOf } from "./legacy-lane-spec.js";

/** The model a lane brings besides the default API client, and the handles its cleanup needs. */
export interface ParticipantModel {
  provider?: CuaProvider;
  codexParticipant?: ReturnType<typeof createRestrictedCodexParticipant>;
  claudeSession?: Awaited<ReturnType<typeof startClaudeSession>>;
}

/** Starts the lane's model: a caller's provider, the operator's Codex, a Claude session, or none. */
export async function startParticipantModel(
  spec: DesktopParticipantRun,
  deps: CuaLaneDeps,
  executor: CuaExecutor,
): Promise<ParticipantModel> {
  const { config, env } = deps;
  if (deps.hooks.buildProvider) {
    return {
      provider: await deps.hooks.buildProvider({
        config,
        actor: deps.descriptor,
        lane: laneSpecOf(spec),
        laneCount: deps.laneCount,
        executor,
      }),
    };
  }
  if (deps.localAgent === "codex") {
    // Hosted local-agent studies use the same native participant engine as local desktops.
    // Operator auth deliberately retains the operator's Codex home, config and supported auth
    // stores instead of applying the isolated restricted-account profile used by local studies.
    const codexParticipant = createRestrictedCodexParticipant({
      authMode: "operator",
      ...(spec.planned.limits.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: spec.planned.limits.reasoningEffort }),
      ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
      ...(executor.speechEnabled === true ? { speechEnabled: true } : {}),
      session: { env },
    });
    return { provider: codexParticipant.provider, codexParticipant };
  }
  if (deps.localAgent === "claude") {
    // One session for the whole run, like the codex thread above (#520). The one-shot
    // provider (createLocalAgentProvider) spawned `claude -p` per turn, and every turn
    // started with no memory of the last. HUMANISH_LOCAL_AGENT_ONE_SHOT=1 keeps that path
    // reachable as a MEASUREMENT switch: MemTrapBench (2026-08) reports memory frameworks
    // degrading agent performance by 10-40% on some tasks, so "remembers" has to be measured
    // against "does not" on the same lab, not assumed. The trace records which one ran.
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
          ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
        }),
      };
    }
    const claudeSession = await startClaudeSession({
      ...(spec.planned.limits.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: spec.planned.limits.reasoningEffort }),
      ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
    });
    return { provider: claudeSession.provider, claudeSession };
  }
  return {};
}

/** The options the lane's session runs with: prompt, model settings, spend caps and callbacks. */
export function participantSessionOptions(
  spec: DesktopParticipantRun,
  deps: CuaLaneDeps,
  ready: ReadyCuaDesktop,
  provider: CuaProvider | undefined,
  writeScreenshot: NonNullable<CuaActorSessionOptions["writeScreenshot"]>,
): CuaActorSessionOptions {
  const { config } = deps;
  const { executor, inbox } = ready;
  // The FAIL-CLOSED spend cap (execution.caps.maxUsd) is wired into the loop as maxUsd + an
  // injected pure per-turn estimator keyed on the resolved model. Preflight already refused a
  // cap on an unpriced model, so the estimate is measurable whenever a cap is in force. The
  // model id here matches provider.version (openai-responses-cu resolves the default when unset).
  const capModelId = config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL;
  const maxUsd = config.execution?.caps?.maxUsd;
  return {
    instructions: inbox
      ? withInboxMission(spec, inbox.url, inbox.address, inbox.receiving).instructions
      : spec.instructions,
    persona: spec.persona,
    timeoutMs: deps.timeoutMs,
    // The brain is either a keyed API client or a CLI the operator is already signed in to.
    // Everything below this line — loop, executor, trace, affordances — is identical either
    // way, which is what makes a local-agent run comparable to an API one.
    ...(provider === undefined ? {} : { provider: provider }),
    openai: {
      apiKey: deps.openaiApiKey,
      ...(config.actors[0]?.model ? { model: config.actors[0]!.model } : {}),
      // Per-LANE, not per-actor: two lanes at different efforts is the control this exists for.
      ...(spec.planned.limits.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: spec.planned.limits.reasoningEffort }),
      ...(spec.planned.limits.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: spec.planned.limits.maxOutputTokens }),
    },
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
    ...(spec.planned.tasks === undefined ? {} : { tasks: spec.planned.tasks }),
    // The STUDY budget (#299): this lane notes its own running estimate on the shared ledger
    // and stops when the RUN total crosses the cap — independent of the per-lane maxUsd above.
    ...(deps.runBudget === undefined
      ? {}
      : {
          overRunBudget: (usage: ActorTokenUsage): string | null => {
            const estimate = estimateActorCostForExecution(
              usage,
              provider?.version ?? capModelId,
              provider?.executionProfile,
            ).estimatedCostUsd;
            const totalUsd = deps.runBudget!.note(spec.planned.id, estimate);
            return totalUsd > deps.runBudget!.maxTotalUsd
              ? `study budget reached: the run's estimated model spend $${round6(totalUsd)} crossed execution.caps.maxTotalUsd=$${deps.runBudget!.maxTotalUsd}; this lane stops here and sibling lanes stop at their next turn`
              : null;
          },
        }),
    ...(deps.onObservedUrl === undefined ? {} : { onObservedUrl: deps.onObservedUrl }),
    ...(deps.onMessage === undefined ? {} : { onMessage: deps.onMessage }),
    ...(deps.onScreenshot === undefined ? {} : { onScreenshot: deps.onScreenshot }),
    ...(deps.onTrace === undefined
      ? {}
      : {
          // Forwards the RUNNING usage as well: the lane is where both are known, and usage
          // without it never reaches the flush — which is how the live cost stayed unknown.
          onTrace: (
            items: readonly ActorTraceItem[],
            usage: ActorTokenUsage,
            metadata?: CuaLiveMetadata,
          ): void => deps.onTrace?.(spec.planned.id, items, usage, metadata),
        }),
  };
}

/**
 * Closes the lane's model, in the order it was opened. Returns true when a provider's cleanup is
 * unconfirmed; each failure also adds a warning.
 */
export async function closeParticipantModel(
  model: ParticipantModel,
  warnings: string[],
): Promise<boolean> {
  let unconfirmed = false;
  try {
    if (model.codexParticipant === undefined) await model.provider?.close?.();
  } catch {
    warnings.push("Model provider cleanup is unconfirmed.");
    unconfirmed = true;
  }
  try {
    const cleanup = await model.codexParticipant?.close();
    if (cleanup?.status === "unconfirmed") {
      warnings.push("Model provider cleanup is unconfirmed.");
      unconfirmed = true;
    }
  } catch {
    warnings.push("Model provider cleanup is unconfirmed.");
    unconfirmed = true;
  }
  try {
    await model.claudeSession?.close();
  } catch {
    warnings.push("Claude session cleanup failed; desktop cleanup will still run.");
  }
  return unconfirmed;
}

/** Prices the finished session's tokens onto its trace, writes the trace, and warns on raw screenshots. */
export async function recordParticipantTrace(
  spec: DesktopParticipantRun,
  deps: CuaLaneDeps,
  session: CuaLoopResult,
  warnings: string[],
): Promise<void> {
  // Per-lane model-token cost ESTIMATE, attached to the trace before it is persisted (the model
  // id is authoritative here — provider.version). Kept at the lab boundary so the pure loop
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
  if (session.trace.redaction.screenshots === "raw") {
    warnings.push(
      "Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .humanish and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.",
    );
  }
}

/** The checks that keep a goal_satisfied session from counting as a pass, with their warnings. */
export function judgeParticipantSession(
  session: CuaLoopResult | undefined,
  deps: CuaLaneDeps,
  warnings: string[],
): { noEngagement: boolean; selfReportedBlocker: boolean; reportedFriction: boolean } {
  const noEngagement = session !== undefined && hollowCompletion(sessionEnding(session));
  if (noEngagement) {
    warnings.push(
      "Actor returned goal_satisfied with ZERO actions and ZERO messages — it likely saw a blank or still-loading screen and stopped without engaging. NOT counted as a pass. Check the screenshot; raise execution.timeoutMs or confirm the subject painted before the first turn.",
    );
  }

  const blockerReason = resolveSelfReportedBlocker(session);
  const selfReportedBlocker = blockerReason !== undefined;
  const reportedFriction = resolveSelfReportedFriction(session) !== undefined;
  if (selfReportedBlocker) {
    warnings.push(
      `Actor returned goal_satisfied while its final message describes a blocker or asks for missing instructions — NOT counted as a pass: ${redactText(deps.scrubKnownValues(blockerReason))}`,
    );
  }
  return { noEngagement, selfReportedBlocker, reportedFriction };
}
