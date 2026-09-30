import { collectDesktopRecording } from "../../evidence/desktop-recording-artifact.js";
import path from "node:path";
import { runLab, type LabOutcome, type RunLabOptions } from "../../lab/engine.js";
import type { LabConfig } from "../../lab/config.js";
import { inboxRecipientFor, type DesktopLaneEvidence } from "../../cua-desktop-lane.js";
import { runCuaActorSession } from "../../actors/computer-use/actor.js";
import {
  createLocalFirecrackerDesktop,
  type LocalFirecrackerAssets,
  type LocalFirecrackerDesktop,
} from "./firecracker-desktop.js";
import { localBrowserDefaults, localBrowserUnsupportedReason } from "./runtime-config.js";
import { prepareLocalRuntime } from "./runtime.js";
import { checkRestrictedCodexAnalysisReadiness } from "../../analysis/restricted-codex.js";
import { createRestrictedCodexParticipant } from "../../actors/codex/restricted-participant.js";
import { guestMediaConfigSchema } from "../../guest-media-config.js";
import { startLocalCapturedInbox } from "./captured-inbox.js";

/** Local desktop/provider composition over the shared lab runner. */
export async function runLocalFirecrackerStudy(
  options: RunLabOptions & {
    config: LabConfig;
    assets?: LocalFirecrackerAssets;
    signal?: AbortSignal;
  },
): Promise<LabOutcome> {
  const config = localBrowserDefaults(options.config);
  const unsupported = localBrowserUnsupportedReason(config);
  if (unsupported) throw new Error(unsupported);
  const recording = config.execution?.desktop?.recording;
  const declaredMedia = config.execution?.desktop?.media;
  const media =
    declaredMedia === undefined
      ? undefined
      : guestMediaConfigSchema.parse({
          ...declaredMedia,
          permission: config.policies?.mediaPermission ?? "prompt",
        });
  const account = config.actors[0]?.type === "local-agent";
  let preparing: Promise<LocalFirecrackerAssets> | undefined;
  const assets = (): Promise<LocalFirecrackerAssets> =>
    (preparing ??= (async () => {
      if (account) {
        const readiness = await checkRestrictedCodexAnalysisReadiness({ timeoutMs: 5000 });
        if (!readiness.ready)
          throw new Error(
            `Codex account is not ready (${readiness.errorCode}). Run humanish doctor --lab <lab> before starting a local study.`,
          );
      }
      return (
        options.assets ??
        (await prepareLocalRuntime({
          ...(media === undefined && recording === undefined ? {} : { media: true }),
          ...(options.signal ? { signal: options.signal } : {}),
          progress: (message) => process.stderr.write(`${message}\n`),
        }))
      );
    })());
  const sessions: LocalFirecrackerDesktop[] = [];
  const participants: ReturnType<typeof createRestrictedCodexParticipant>[] = [];
  let cleanupUnconfirmed = false;
  try {
    return await runLab(config, {
      ...options,
      automaticAnalysis: {
        ...options.automaticAnalysis,
        onStart() {
          if (cleanupUnconfirmed) throw new Error("Local study cleanup is unconfirmed.");
          return options.automaticAnalysis?.onStart?.();
        },
      },
      cuaHooks: {
        createDesktopLane(spec, warnings, artifactRoot) {
          let session: LocalFirecrackerDesktop | undefined;
          let inbox: Awaited<ReturnType<typeof startLocalCapturedInbox>> | undefined;
          const email = config.comms?.email;
          const address =
            email?.kind === "fake" ? inboxRecipientFor(email, spec.laneId)?.address : undefined;
          let finalizing: Promise<void> | undefined;
          const evidence: DesktopLaneEvidence = {
            killed: false,
            streamUrlPresent: false,
            stateStepRecords: [],
            phaseRecords: [],
          };
          return {
            async prepare() {
              const runtime = await assets();
              if (address && email?.kind === "fake" && email.external)
                inbox = await startLocalCapturedInbox(email.external, address);
              session = await createLocalFirecrackerDesktop({
                assets: runtime,
                ...(inbox ? { inboxUrl: inbox.url } : {}),
                ...(media === undefined ? {} : { media }),
                ...(recording === undefined ? {} : { recording }),
                appUrl: spec.targetUrl ?? config.subject.appUrl!,
                outputRoot: path.join(options.cwd, ".humanish", "local-runtime"),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              });
              sessions.push(session);
              if (media !== undefined)
                evidence.desktopBrowser = {
                  requested: "chromium",
                  resolved: "chromium",
                  media: {
                    ...(media.camera === undefined
                      ? {}
                      : { camera: { source: "synthetic", file: "/dev/video0" } }),
                    ...(media.microphone === undefined ? {} : { microphone: { source: "speech" } }),
                    permission: media.permission,
                    flags: media.permission === "granted" ? ["--use-fake-ui-for-media-stream"] : [],
                  },
                };
            },
            async openSession() {
              if (!session) throw new Error("The local desktop has not been prepared.");
              return {
                executor: session.executor,
                ...(inbox && address ? { inbox: { url: inbox.url, address } } : {}),
              };
            },
            finalize() {
              return (finalizing ??= (async () => {
                try {
                  await inbox?.close();
                } catch {
                  cleanupUnconfirmed = true;
                  warnings.push("Local inbox cleanup is unconfirmed.");
                }
                if (!session) return;
                if (recording) {
                  const desktop = session;
                  try {
                    evidence.recording = await collectDesktopRecording(
                      artifactRoot,
                      spec.laneId,
                      (destination) => desktop.finishRecording(destination),
                    );
                  } catch {
                    warnings.push(
                      "Desktop video/audio recording could not be retained. Screenshots and participant evidence remain available.",
                    );
                  }
                }
                try {
                  evidence.killed = (await session.close()).status === "released";
                } catch {
                  evidence.killed = false;
                }
                if (!evidence.killed) {
                  cleanupUnconfirmed = true;
                  warnings.push("Local desktop cleanup is unconfirmed.");
                }
              })());
            },
            snapshot: () => evidence,
          };
        },
        ...(account
          ? {
              async buildProvider({ executor }) {
                const participant = createRestrictedCodexParticipant({
                  speechEnabled: executor?.speechEnabled === true,
                });
                participants.push(participant);
                return Object.assign(participant.provider, {
                  async close() {
                    if ((await participant.close()).status !== "confirmed") {
                      cleanupUnconfirmed = true;
                      throw new Error("Local participant cleanup is unconfirmed.");
                    }
                  },
                });
              },
            }
          : {}),
        ...(options.signal
          ? {
              runSession: (input: Parameters<typeof runCuaActorSession>[0]) =>
                runCuaActorSession({ ...input, signal: options.signal! }),
            }
          : {}),
      },
    });
  } finally {
    await Promise.allSettled(participants.map((participant) => participant.close()));
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}
