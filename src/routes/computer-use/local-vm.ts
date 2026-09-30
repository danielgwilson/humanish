import { collectDesktopRecording } from "../../evidence/desktop-recording-artifact.js";
import path from "node:path";
import { dispatchLab, type LabOutcome, type RunLabOptions } from "../../lab/engine.js";
import type { LabConfig } from "../../lab/types.js";
import {
  inboxRecipientFor,
  type CuaDesktopLane,
  type DesktopLaneEvidence,
} from "./desktop-lane.js";
import type { CuaActorLabHooks } from "./types.js";
import type { CuaLaneSpec } from "./legacy-lane-spec.js";
import { HOOK_MEMBERS, withHookOverrides } from "../../lab/hook-bag.js";
import { runCuaActorSession } from "../../actors/computer-use/actor.js";
import {
  createLocalFirecrackerDesktop,
  type LocalFirecrackerAssets,
  type LocalFirecrackerDesktop,
} from "../../substrates/local/firecracker-desktop.js";
import {
  localBrowserDefaults,
  localBrowserUnsupportedReason,
} from "../../substrates/local/runtime-config.js";
import { prepareLocalRuntime } from "../../substrates/local/runtime.js";
import { checkRestrictedCodexAnalysisReadiness } from "../../analysis/restricted-codex.js";
import { createRestrictedCodexParticipant } from "../../actors/codex/restricted-participant.js";
import { guestMediaConfigSchema, type GuestMediaConfig } from "../../guest-media-config.js";
import { startLocalCapturedInbox } from "../../substrates/local/captured-inbox.js";
import type { DesktopRecordingConfig } from "../../evidence/desktop-recording-types.js";
import type { PreparedOutputRoot } from "../../run/contained-output.js";

// These hooks act on an E2B desktop or the local-tree upload to it. The study runs on a
// Firecracker desktop and never calls them, so a caller relying on one gets an error up front.
const e2bDesktopHooks = [
  "prepareDesktop",
  "loadDesktopModule",
  "onRuntimeStreamReady",
  "packLocalTree",
] as const satisfies readonly (keyof CuaActorLabHooks)[];

function refuseE2BDesktopHooks(hooks: CuaActorLabHooks | undefined): void {
  const present = e2bDesktopHooks.filter((name) => hooks?.[name] !== undefined);
  if (present.length === 0) return;
  throw new Error(
    `A local browser study runs on a Firecracker desktop and does not call ${present.map((name) => `cuaHooks.${name}`).join(", ")}. These hooks apply only to E2B desktops.`,
  );
}

type LocalStudyOptions = RunLabOptions & {
  config: LabConfig;
  assets?: LocalFirecrackerAssets;
  signal?: AbortSignal;
};

/** What one study's lanes and participants share: their cleanup handles and one unconfirmed flag. */
interface LocalStudyState {
  readonly sessions: LocalFirecrackerDesktop[];
  readonly participants: ReturnType<typeof createRestrictedCodexParticipant>[];
  cleanupUnconfirmed: boolean;
}

/** The inputs every lane of one local study reads. */
interface LocalLaneContext {
  readonly config: LabConfig;
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly media: GuestMediaConfig | undefined;
  readonly recording: DesktopRecordingConfig | undefined;
  readonly assets: () => Promise<LocalFirecrackerAssets>;
  readonly state: LocalStudyState;
}

function studyMedia(config: LabConfig): GuestMediaConfig | undefined {
  const declaredMedia = config.execution?.desktop?.media;
  return declaredMedia === undefined
    ? undefined
    : guestMediaConfigSchema.parse({
        ...declaredMedia,
        permission: config.policies?.mediaPermission ?? "prompt",
      });
}

/** The runtime image, prepared once per study on first use, after the account check. */
function studyAssets(
  options: LocalStudyOptions,
  account: boolean,
  needsMedia: boolean,
): () => Promise<LocalFirecrackerAssets> {
  let preparing: Promise<LocalFirecrackerAssets> | undefined;
  return () =>
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
          ...(needsMedia ? { media: true } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          progress: (message) => process.stderr.write(`${message}\n`),
        }))
      );
    })());
}

function mediaEvidence(
  media: GuestMediaConfig,
): NonNullable<DesktopLaneEvidence["desktopBrowser"]> {
  return {
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
}

/** One lane's Firecracker desktop and optional captured inbox, released in finalize. */
function createLocalDesktopLane(
  context: LocalLaneContext,
  spec: CuaLaneSpec,
  warnings: string[],
  artifactRoot: PreparedOutputRoot,
): CuaDesktopLane {
  const { config, media, recording, state } = context;
  let session: LocalFirecrackerDesktop | undefined;
  let inbox: Awaited<ReturnType<typeof startLocalCapturedInbox>> | undefined;
  const email = config.comms?.email;
  const address =
    email?.kind === "fake" ? inboxRecipientFor(email, spec.laneId)?.address : undefined;
  let finalizing: Promise<void> | undefined;
  const evidence: DesktopLaneEvidence = {
    released: false,
    streamUrlPresent: false,
    stateStepRecords: [],
    phaseRecords: [],
  };
  return {
    async prepare() {
      const runtime = await context.assets();
      if (address && email?.kind === "fake" && email.external)
        inbox = await startLocalCapturedInbox(email.external, address);
      session = await createLocalFirecrackerDesktop({
        assets: runtime,
        ...(inbox ? { inboxUrl: inbox.url } : {}),
        ...(media === undefined ? {} : { media }),
        ...(recording === undefined ? {} : { recording }),
        appUrl: spec.targetUrl ?? config.subject.appUrl!,
        outputRoot: path.join(context.cwd, ".humanish", "local-runtime"),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      state.sessions.push(session);
      if (media !== undefined) evidence.desktopBrowser = mediaEvidence(media);
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
          state.cleanupUnconfirmed = true;
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
          evidence.released = (await session.close()).status === "released";
        } catch {
          evidence.released = false;
        }
        if (!evidence.released) {
          state.cleanupUnconfirmed = true;
          warnings.push("Local desktop cleanup is unconfirmed.");
        }
      })());
    },
    snapshot: () => evidence,
  };
}

/** The Codex account participant, whose unconfirmed cleanup blocks the study's analysis. */
function accountProvider(state: LocalStudyState): Pick<CuaActorLabHooks, "buildProvider"> {
  return {
    async buildProvider({ executor }) {
      const participant = createRestrictedCodexParticipant({
        speechEnabled: executor?.speechEnabled === true,
      });
      state.participants.push(participant);
      return Object.assign(participant.provider, {
        async close() {
          if ((await participant.close()).status !== "confirmed") {
            state.cleanupUnconfirmed = true;
            throw new Error("Local participant cleanup is unconfirmed.");
          }
        },
      });
    },
  };
}

/** Local desktop/provider composition over the shared lab runner. */
export async function runLocalFirecrackerStudy(options: LocalStudyOptions): Promise<LabOutcome> {
  const config = localBrowserDefaults(options.config);
  const unsupported = localBrowserUnsupportedReason(config);
  if (unsupported) throw new Error(unsupported);
  refuseE2BDesktopHooks(options.cuaHooks);
  const recording = config.execution?.desktop?.recording;
  const media = studyMedia(config);
  const callerHooks = options.cuaHooks;
  // A caller-supplied provider replaces the Codex account participant, so the account is
  // neither checked nor used.
  const account =
    config.actors[0]?.type === "local-agent" && callerHooks?.buildProvider === undefined;
  const baseRunSession = callerHooks?.runSession ?? runCuaActorSession;
  const state: LocalStudyState = { sessions: [], participants: [], cleanupUnconfirmed: false };
  const context: LocalLaneContext = {
    config,
    cwd: options.cwd,
    signal: options.signal,
    media,
    recording,
    assets: studyAssets(options, account, media !== undefined || recording !== undefined),
    state,
  };
  try {
    return await dispatchLab(config, {
      ...options,
      // Wrapped rather than spread for the same reason as cuaHooks below.
      automaticAnalysis: withHookOverrides(options.automaticAnalysis, HOOK_MEMBERS.analysis, {
        onStart() {
          if (state.cleanupUnconfirmed) throw new Error("Local study cleanup is unconfirmed.");
          return options.automaticAnalysis?.onStart?.();
        },
      }),
      // The caller's hooks come first so this study's desktop lane always wins: dispatchLab reads
      // createDesktopLane as "desktop provided" and does not route back here.
      // The caller's bag may be a class instance, so it is wrapped rather than spread.
      cuaHooks: withHookOverrides(callerHooks, HOOK_MEMBERS.cua, {
        createDesktopLane: (spec, warnings, artifactRoot) =>
          createLocalDesktopLane(context, spec, warnings, artifactRoot),
        ...(account ? accountProvider(state) : {}),
        ...(options.signal
          ? {
              runSession: (input: Parameters<typeof runCuaActorSession>[0]) =>
                baseRunSession({ ...input, signal: options.signal! }),
            }
          : {}),
      }),
    });
  } finally {
    await Promise.allSettled(state.participants.map((participant) => participant.close()));
    await Promise.allSettled(state.sessions.map((session) => session.close()));
  }
}
