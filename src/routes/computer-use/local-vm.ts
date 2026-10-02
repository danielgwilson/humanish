import { collectDesktopRecording } from "../../evidence/desktop-recording-artifact.js";
import path from "node:path";
import type { InternalRunLabOptions } from "../../run-lab.js";
import type { LabConfig } from "../../lab/types.js";
import type { ProviderFactory } from "../../lab/run-lab-options.js";
import {
  inboxRecipientFor,
  type ParticipantDesktop,
  type ParticipantDesktopEvidence,
} from "./participant-desktop.js";
import type { CuaActorLabHooks, DesktopParticipantRun, LocalVmInput } from "./types.js";
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
import { dockerCommandLine } from "../../substrates/local/runtime-host.js";
import { checkRestrictedCodexAnalysisReadiness } from "../../analysis/restricted-codex.js";
import { createRestrictedCodexParticipant } from "../../actors/codex/restricted-participant.js";
import { guestMediaConfigSchema, type GuestMediaConfig } from "../../guest/media-config.js";
import { startLocalCapturedInbox } from "../../substrates/local/captured-inbox.js";
import type { DesktopRecordingConfig } from "../../evidence/desktop-recording-types.js";
import type { PreparedOutputRoot } from "../../run/contained-output.js";

// These hooks act on an E2B desktop or the local-tree upload to it. The study runs on a
// Firecracker desktop and never calls them, so a caller relying on one gets an error up front.
const e2bDesktopHooks = [
  "prepareDesktop",
  "loadDesktopModule",
  "packLocalTree",
] as const satisfies readonly (keyof CuaActorLabHooks)[];

function refuseE2BDesktopHooks(hooks: CuaActorLabHooks | undefined): void {
  const present = e2bDesktopHooks.filter((name) => hooks?.[name] !== undefined);
  if (present.length === 0) return;
  throw new Error(
    `A local browser study runs on a Firecracker desktop and does not call ${present.map((name) => `cuaHooks.${name}`).join(", ")}. These hooks apply only to E2B desktops.`,
  );
}

type LocalStudyOptions = InternalRunLabOptions & {
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

/** The inputs every participant of one local study reads. */
interface LocalParticipantContext {
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
): NonNullable<ParticipantDesktopEvidence["desktopBrowser"]> {
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
function createLocalParticipantDesktop(
  context: LocalParticipantContext,
  run: DesktopParticipantRun,
  warnings: string[],
  artifactRoot: PreparedOutputRoot,
): ParticipantDesktop {
  const { config, media, recording, state } = context;
  let session: LocalFirecrackerDesktop | undefined;
  let inbox: Awaited<ReturnType<typeof startLocalCapturedInbox>> | undefined;
  const email = config.comms?.email;
  const address =
    email?.kind === "fake" ? inboxRecipientFor(email, run.planned.id)?.address : undefined;
  let finalizing: Promise<void> | undefined;
  const evidence: ParticipantDesktopEvidence = {
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
        appUrl: run.planned.targetUrl ?? config.subject.appUrl!,
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
              run.planned.id,
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
          const warning = "Local desktop cleanup is unconfirmed.";
          warnings.push(warning);
          // No receipt names a local VM, so the record carries the command that removes it.
          evidence.sandboxRelease = {
            state: "unconfirmed",
            warning,
            recovery: `If container ${session.resourceId} is still listed by \`${dockerCommandLine(["ps"])}\`, remove it with \`${dockerCommandLine(["rm", "--force", "--volumes", session.resourceId])}\`.`,
          };
        }
      })());
    },
    snapshot: () => evidence,
  };
}

/** The Codex account participant, whose unconfirmed cleanup blocks the study's analysis. */
function accountProvider(state: LocalStudyState): ProviderFactory {
  return async ({ executor }) => {
    const participant = createRestrictedCodexParticipant({
      speechEnabled: executor.speechEnabled === true,
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
  };
}

/** A local browser study's bindings, and the cleanup of what its lanes started. */
export interface LocalVmStudy {
  /** The caller's runLab options, with the account provider when the study runs one. */
  readonly options: InternalRunLabOptions;
  /** The desktop, the analysis gate and the abort signal the computer-use run takes. */
  readonly localVm: LocalVmInput;
  close(): Promise<void>;
}

/**
 * Local desktop/provider composition: the options the lab is planned and run with. It throws before
 * anything starts on a lab the local study cannot run, or on a hook only an E2B desktop calls.
 */
export function prepareLocalVmStudy(options: LocalStudyOptions): LocalVmStudy {
  const config = localBrowserDefaults(options.config);
  const unsupported = localBrowserUnsupportedReason(config);
  if (unsupported) throw new Error(unsupported);
  refuseE2BDesktopHooks(options.cuaHooks);
  const recording = config.execution?.desktop?.recording;
  const media = studyMedia(config);
  // A caller-supplied provider replaces the Codex account participant, so the account is
  // neither checked nor used.
  const account = config.actors[0]?.type === "local-agent" && options.createProvider === undefined;
  const state: LocalStudyState = { sessions: [], participants: [], cleanupUnconfirmed: false };
  const context: LocalParticipantContext = {
    config,
    cwd: options.cwd,
    signal: options.signal,
    media,
    recording,
    assets: studyAssets(options, account, media !== undefined || recording !== undefined),
    state,
  };
  const { config: _config, assets: _assets, signal: _signal, ...runOptions } = options;
  return {
    options: account ? { ...runOptions, createProvider: accountProvider(state) } : runOptions,
    localVm: {
      desktop: (run, warnings, artifactRoot) =>
        createLocalParticipantDesktop(context, run, warnings, artifactRoot),
      analysisRefusal: () =>
        state.cleanupUnconfirmed ? "AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED" : undefined,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    async close() {
      await Promise.allSettled(state.participants.map((participant) => participant.close()));
      await Promise.allSettled(state.sessions.map((session) => session.close()));
    },
  };
}
