import path from "node:path";
import { runLab, type LabOutcome, type RunLabOptions } from "./lab-engine.js";
import type { LabConfig } from "./lab-config.js";
import type { DesktopSession } from "./desktop-session.js";
import type { DesktopLaneEvidence } from "./cua-desktop-lane.js";
import { runCuaActorSession } from "./computer-use-actor.js";
import { createLocalFirecrackerDesktop, type LocalFirecrackerAssets } from "./local-firecracker-desktop.js";
import { localBrowserDefaults, localBrowserUnsupportedReason } from "./local-runtime-config.js";
import { prepareLocalRuntime } from "./local-runtime.js";
import { checkRestrictedCodexAnalysisReadiness } from "./restricted-codex-analysis.js";
import { createRestrictedCodexParticipant } from "./restricted-codex-participant.js";

/** Local desktop/provider composition over the shared lab runner. */
export async function runLocalFirecrackerStudy(options: RunLabOptions & {
  config: LabConfig; assets?: LocalFirecrackerAssets; signal?: AbortSignal;
}): Promise<LabOutcome> {
  const config = localBrowserDefaults(options.config);
  const unsupported = localBrowserUnsupportedReason(config);
  if (unsupported) throw new Error(unsupported);
  const account = config.actors[0]?.type === "local-agent";
  let preparing: Promise<LocalFirecrackerAssets> | undefined;
  const assets = (): Promise<LocalFirecrackerAssets> => preparing ??= (async () => {
    if (account) {
      const readiness = await checkRestrictedCodexAnalysisReadiness({ timeoutMs: 5000 });
      if (!readiness.ready) throw new Error(`Codex account is not ready (${readiness.errorCode}). Run humanish doctor --lab <lab> before starting a local study.`);
    }
    return options.assets ?? await prepareLocalRuntime({
      ...(options.signal ? { signal: options.signal } : {}),
      progress: message => process.stderr.write(`${message}\n`)
    });
  })();
  const sessions: DesktopSession[] = [];
  const participants: ReturnType<typeof createRestrictedCodexParticipant>[] = [];
  let cleanupUnconfirmed = false;
  try {
    return await runLab(config, { ...options,
      automaticAnalysis: { ...options.automaticAnalysis, onStart() {
        if (cleanupUnconfirmed) throw new Error("Local study cleanup is unconfirmed.");
        return options.automaticAnalysis?.onStart?.();
      } },
      cuaHooks: {
        createDesktopLane(spec, warnings) {
          let session: DesktopSession | undefined;
          let finalizing: Promise<void> | undefined;
          const evidence: DesktopLaneEvidence = { killed: false, streamUrlPresent: false, stateStepRecords: [], phaseRecords: [] };
          return {
            async prepare() {
              session = await createLocalFirecrackerDesktop({ assets: await assets(),
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
        ...(account ? { async buildProvider() {
          const participant = createRestrictedCodexParticipant();
          participants.push(participant);
          return Object.assign(participant.provider, { async close() {
            if ((await participant.close()).status !== "confirmed") {
              cleanupUnconfirmed = true;
              throw new Error("Local participant cleanup is unconfirmed.");
            }
          } });
        } } : {}),
        ...(options.signal ? { runSession: (input: Parameters<typeof runCuaActorSession>[0]) => runCuaActorSession({ ...input, signal: options.signal! }) } : {})
      }
    });
  } finally {
    await Promise.allSettled(participants.map(participant => participant.close()));
    await Promise.allSettled(sessions.map(session => session.close()));
  }
}
