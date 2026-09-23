import path from "node:path";
import { runLab, type LabOutcome } from "./lab-engine.js";
import type { LabConfig } from "./lab-config.js";
import type { DesktopSession } from "./desktop-session.js";
import type { DesktopLaneEvidence } from "./cua-desktop-lane.js";
import { runCuaActorSession } from "./computer-use-actor.js";
import { createLocalFirecrackerDesktop, type LocalFirecrackerAssets } from "./local-firecracker-desktop.js";
import { createRestrictedCodexParticipant } from "./restricted-codex-participant.js";

/** Development entrypoint over explicitly supplied assets. All study execution,
 * evidence and analysis remain in the normal lab runner. No installer/default selection. */
export async function runLocalFirecrackerStudy(options: {
  cwd: string; config: LabConfig; assets: LocalFirecrackerAssets; runId?: string; signal?: AbortSignal;
}): Promise<LabOutcome> {
  const { config } = options;
  const actor = config.actors[0];
  const desktop = config.execution?.desktop;
  if (config.subject.source !== "app-url" || config.execution?.target !== "local" || config.actors.length !== 1 ||
    actor?.type !== "openai-computer-use" || actor.model !== "gpt-6-astra" ||
    (actor.reasoningEffort !== undefined && actor.reasoningEffort !== "low") ||
    actor.maxOutputTokens !== undefined || actor.lanes?.some(lane =>
      (lane.reasoningEffort !== undefined && lane.reasoningEffort !== "low") || lane.device !== undefined) ||
    desktop?.resolution?.[0] !== 960 || desktop.resolution[1] !== 720 || desktop.device !== undefined ||
    (desktop.browser !== undefined && !["default", "chromium"].includes(desktop.browser)) ||
    desktop.media !== undefined || desktop.template !== undefined || desktop.sandboxTimeoutMs !== undefined || config.comms !== undefined ||
    config.execution.caps?.maxUsd !== undefined || config.execution.caps?.maxTotalUsd !== undefined ||
    config.scenario?.caps?.maxUsd !== undefined || config.scenario?.caps?.maxTotalUsd !== undefined ||
    (config.review?.analysis !== false && (!config.review?.analysis || config.review.analysis.provider !== "codex"))) {
    throw new Error("This development runtime requires local app-url, gpt-6-astra at low effort, 960×720 Chromium, no comms/media or dollar/output caps, and Codex analysis (or analysis disabled).");
  }
  const sessions: DesktopSession[] = [];
  const participants: ReturnType<typeof createRestrictedCodexParticipant>[] = [];
  let cleanupUnconfirmed = false;
  try {
    return await runLab(config, { cwd: options.cwd, dryRun: false, open: false,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      automaticAnalysis: { onStart() { if (cleanupUnconfirmed) throw new Error("Local study cleanup is unconfirmed."); } },
      cuaHooks: {
        env: {},
        createDesktopLane(spec, warnings) {
          let session: DesktopSession | undefined;
          let finalizing: Promise<void> | undefined;
          const evidence: DesktopLaneEvidence = { killed: false, streamUrlPresent: false, stateStepRecords: [], phaseRecords: [] };
          return {
            async prepare() {
              session = await createLocalFirecrackerDesktop({ assets: options.assets,
                appUrl: spec.targetUrl ?? config.subject.appUrl!, outputRoot: path.join(options.cwd, ".humanish", "local-runtime"),
                ...(options.signal === undefined ? {} : { signal: options.signal }) });
              sessions.push(session);
            },
            async openSession() {
              if (!session) throw new Error("The local desktop has not been prepared.");
              return { executor: session.executor };
            },
            finalize() {
              return finalizing ??= (async () => {
                if (!session) return;
                try { evidence.killed = (await session.close()).status === "released"; }
                catch { evidence.killed = false; }
                if (!evidence.killed) { cleanupUnconfirmed = true; warnings.push("Local desktop cleanup is unconfirmed."); }
              })();
            },
            snapshot: () => evidence
          };
        },
        async buildProvider() {
          const participant = createRestrictedCodexParticipant();
          participants.push(participant);
          return Object.assign(participant.provider, { async close() {
            if ((await participant.close()).status !== "confirmed") {
              cleanupUnconfirmed = true;
              throw new Error("Local participant cleanup is unconfirmed.");
            }
          } });
        },
        runSession: input => runCuaActorSession({ ...input, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      }
    });
  } finally {
    await Promise.allSettled(participants.map(participant => participant.close()));
    await Promise.allSettled(sessions.map(session => session.close()));
  }
}
