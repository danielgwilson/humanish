import type { LabConfig } from "./lab-config.js";
import { runLab, type LabOutcome } from "./lab-engine.js";
import { runCuaActorSession } from "./computer-use-actor.js";
import type { DesktopSession, DesktopReleaseResult } from "./desktop-session.js";
import type { AutomaticAnalysisHooks } from "./automatic-analysis-completion.js";
import { createRestrictedCodexParticipant, type ParticipantProviderCloseResult, type RestrictedParticipantOptions } from "./restricted-codex-participant.js";
import { CuaProviderError } from "./cua-provider-error.js";

/** Internal, explicit single-participant consumer. Uses the existing producer and
 * its automatic-completion boundary; never allocates or discovers a desktop. */
export async function runRestrictedParticipantStudy(options: {
  cwd: string; config: LabConfig; desktop: DesktopSession; participant?: RestrictedParticipantOptions;
  signal?: AbortSignal; runId?: string; automaticAnalysis?: AutomaticAnalysisHooks;
}): Promise<{ outcome: LabOutcome; providerCleanup: ParticipantProviderCloseResult; desktopCleanup: DesktopReleaseResult }> {
  let participant: ReturnType<typeof createRestrictedCodexParticipant> | undefined;
  let providerCleanup: ParticipantProviderCloseResult = { status: "unconfirmed" };
  let desktopCleanup: DesktopReleaseResult = { status: "unconfirmed", reason: "release_unavailable" };
  let cleanupUncertain = false;
  let finalized = false;
  let finalizing: Promise<void> | undefined;
  const finish = (): Promise<void> => finalizing ??= (async () => {
    try { if (participant) providerCleanup = await participant.close(); }
    catch { providerCleanup = { status: "unconfirmed" }; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      desktopCleanup = await Promise.race([Promise.resolve().then(() => options.desktop.close()), new Promise<DesktopReleaseResult>(resolve => {
        timer = setTimeout(() => resolve({ status: "unconfirmed", reason: "release_unavailable" }), 10_000);
      })]);
    } catch { desktopCleanup = { status: "unconfirmed", reason: "release_failed" }; }
    finally { clearTimeout(timer); }
    cleanupUncertain ||= providerCleanup.status !== "confirmed" || desktopCleanup.status !== "released";
    finalized = true;
  })();
  try {
    const config = options.config;
    if (config.subject.source !== "local-app" || config.actors.length !== 1 || config.actors[0]?.type !== "openai-computer-use" ||
      (config.actors[0].model !== undefined && config.actors[0].model !== "gpt-6-astra") ||
      (config.actors[0].reasoningEffort !== undefined && config.actors[0].reasoningEffort !== "low") ||
      (config.actors[0]?.count ?? 1) !== 1 || (config.execution?.concurrency ?? 1) !== 1 ||
      config.actors[0]?.lanes?.length ||
      config.actors[0]?.maxOutputTokens !== undefined || config.execution?.caps?.maxUsd !== undefined ||
      config.execution?.caps?.maxTotalUsd !== undefined || config.scenario?.caps?.maxUsd !== undefined || config.scenario?.caps?.maxTotalUsd !== undefined ||
      !Number.isFinite(config.execution?.timeoutMs) || config.execution!.timeoutMs! < 1 || config.execution!.timeoutMs! > 600_000 ||
      (config.review?.analysis !== false && (!config.review?.analysis || config.review.analysis.provider !== "codex"))) {
      throw new CuaProviderError("request_rejected", { dispatched: false, usageComplete: false, cleanup: "confirmed" });
    }
    participant = createRestrictedCodexParticipant(options.participant);
    const outcome = await runLab(config, { cwd: options.cwd, dryRun: false, open: false,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      automaticAnalysis: { ...options.automaticAnalysis, onStart: () => {
        if (!finalized || cleanupUncertain || providerCleanup.status !== "confirmed" || desktopCleanup.status !== "released") throw new Error("participant_cleanup_unconfirmed");
        return options.automaticAnalysis?.onStart?.();
      } },
      cuaHooks: { env: {}, buildExecutor: async () => options.desktop.executor,
        buildProvider: async () => participant!.provider,
        runSession: async input => {
          try {
            const result = await runCuaActorSession({ ...input, ...(options.signal === undefined ? {} : { signal: options.signal }) });
            cleanupUncertain ||= result.trace.providerRequests?.some(r => r.cleanup !== "confirmed") === true;
            return result;
          } finally { await finish(); }
        } }
    });
    await finish();
    return { outcome, providerCleanup, desktopCleanup };
  } finally { await finish(); }
}
