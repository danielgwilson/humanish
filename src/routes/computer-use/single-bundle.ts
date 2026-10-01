import type { RunDesktopRecording } from "../../evidence/desktop-recording-types.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import type { DesktopBrowserEvidence } from "../../substrates/e2b/desktop-browser.js";
import type { ActorPersonaRef, ActorStatus } from "../../actors/contract.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { redactText } from "../../evidence/redaction.js";
import { type RunLabProvenance } from "../../run/status.js";
import {
  REVIEW_SCHEMA,
  bundleArtifacts,
  bundleHead,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunFeedbackCandidate,
  type RunProviderResource,
  type RunSimulation,
} from "../../run/bundle.js";
import {
  type RunDesktopGeometry,
  type RunSimulationStatus,
  type RunStream,
} from "../../run/streams.js";
import {
  aggregateTaskFunnels,
  tallyParticipantOutcomes,
  withCuaReviewProvenance,
} from "../../run/outcomes.js";
import {
  describeSubjectState,
  participantFeedbackCandidates,
  publicSafeAppUrlLabel,
  subjectProvenanceMessage,
} from "./bundle-parts.js";
import { participantStatus as participantStatusFor, type Verdict } from "../../run/judge.js";
import { buildRunCostSummary, type DesktopUsage } from "../../run/cost-summary.js";
import { phaseEventIdSuffix } from "./lane-plan.js";
import {
  participantEvent,
  participantIds,
  participantRecord,
  participantStream,
} from "../../run/participant-records.js";
import type { CuaSubjectProvenanceArg } from "./types.js";

type SingleParticipantBundleArgs = Parameters<typeof buildSingleParticipantBundle>[0];

/** The one participant's record and stream ids: sim-001 and stream-001. */
const SINGLE = participantIds(0);

/** The participant's runner: a hosted E2B desktop, a local VM desktop, or the in-process route. */
function runnerSubstrate(args: SingleParticipantBundleArgs): RunFeedbackCandidate["substrate"] {
  return args.substrate ?? (args.desktopRoute === false ? "local-filesystem" : "e2b-desktop");
}

/** Where the participant's browser ran, as the bundle's summary and stream intent say it. */
function browserPlace(args: SingleParticipantBundleArgs): string {
  switch (runnerSubstrate(args)) {
    case "local-desktop":
      return "in a browser on a local VM";
    case "local-filesystem":
      return "in process, with no desktop";
    default:
      return "in a hosted desktop browser";
  }
}

/** Run-level cost ESTIMATE (advisory; omitted when nothing was priced and no sandbox ran). */
function runCost(args: SingleParticipantBundleArgs): ReturnType<typeof buildRunCostSummary> {
  return buildRunCostSummary({
    participants: args.session
      ? [
          {
            ...(args.participantId === undefined ? {} : { participantId: args.participantId }),
            trace: args.session.trace,
          },
        ]
      : [],
    desktopMinutes: args.desktopMinutes,
    ...(args.desktopUsage === undefined ? {} : { desktops: [args.desktopUsage] }),
  });
}

/** The participant's status, reason, last frame, geometry and screenshot mode, shared by its records. */
function participantView(args: SingleParticipantBundleArgs, publicAppUrl: string) {
  const status: RunSimulationStatus =
    args.inProgress === true
      ? "running"
      : args.session
        ? args.session.status
        : args.sessionError !== undefined
          ? "failed"
          : "contract_proof_only";
  const reason =
    args.inProgress === true
      ? "Live computer-use session is running; stream auth URL is available only through the attached Observer server."
      : (args.session?.reason ??
        args.sessionError ??
        "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.");
  const lastScreenshot = args.screenshots[args.screenshots.length - 1];
  const desktopGeometry =
    args.desktopRoute === false
      ? undefined
      : (args.desktopGeometry ?? {
          screen: { requested: { width: args.resolution[0], height: args.resolution[1] } },
        });

  // Honest labels (invariant 6: claims match mechanism): every screenshot label names the
  // run's ACTUAL mode. The session trace is the evidence-of-record; the capture policy covers
  // frames written before a mid-session failure produced a trace.
  const traceScreenshotMode = args.session?.trace.redaction.screenshots;
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : (args.captureRedaction ?? "raw");
  return {
    publicAppUrl,
    status,
    reason,
    lastScreenshot,
    desktopGeometry,
    traceScreenshotMode,
    screenshotMode,
  };
}

type ParticipantView = ReturnType<typeof participantView>;

function singleSimulation(args: SingleParticipantBundleArgs, view: ParticipantView): RunSimulation {
  const { publicAppUrl, status, reason } = view;
  return participantRecord(SINGLE, 1, {
    personaId: args.persona.id,
    scenarioId: `cua-${args.labId}`,
    status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: args.inProgress === true ? 20 : 100,
    currentStep: reason,
    summary: args.session
      ? `Computer-use actor (${args.actorId}) drove the subject app ${browserPlace(args)}; ${args.session.completionReason}.`
      : args.inProgress === true
        ? `Computer-use actor (${args.actorId}) is driving the subject app ${browserPlace(args)}.`
        : args.sessionError !== undefined
          ? `Computer-use lab failed before a terminal session verdict: ${args.sessionError}`
          : `Contract lane for the computer-use actor (${args.actorId}) against ${publicAppUrl}.`,
    startedAt: args.createdAt,
    updatedAt: args.createdAt,
  });
}

function singleStream(args: SingleParticipantBundleArgs, view: ParticipantView): RunStream {
  const { publicAppUrl, status, reason, lastScreenshot, desktopGeometry, screenshotMode } = view;
  return participantStream(
    SINGLE,
    {
      ...(args.assignment === undefined
        ? {}
        : { assignment: participantAssignment(args.assignment) }),
      ...(args.actorType === undefined ? {} : { actorType: args.actorType }),
      ...(args.surface === undefined ? {} : { surface: args.surface }),
      ...(args.caseGroup === undefined ? {} : { caseGroup: args.caseGroup }),
      kind: "browser",
      label: `CUA browser — ${args.labId}`,
      status,
      transport: "snapshot",
      updatedAt: args.createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `CUA desktop (${screenshotMode})` }
        : { kind: "placeholder", title: "CUA desktop" },
      ...(desktopGeometry?.viewport === undefined
        ? {}
        : {
            viewport: {
              width: desktopGeometry.viewport.width,
              height: desktopGeometry.viewport.height,
              deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
              ...(args.isMobile === undefined ? {} : { isMobile: args.isMobile }),
            },
          }),
      ...(desktopGeometry === undefined ? {} : { desktopGeometry }),
      ...(args.recording === undefined ? {} : { recording: args.recording }),
      ui: {
        route: publicAppUrl,
        intent: `Watch the computer-use actor drive the subject app ${browserPlace(args)}.`,
        state: reason,
        ...(args.session ? { actorStatus: args.session.status } : {}),
        ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {}),
      },
      // The seam this lab exists to fill: the provider-neutral actor evidence projection.
      ...(args.session ? { actor: args.session.trace } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" as const },
        { label: "review", path: "review.md", kind: "review" as const },
        { label: "events", path: "events.ndjson", kind: "events" as const },
        ...(args.traceArtifactPath
          ? [{ label: "actor trace", path: args.traceArtifactPath, kind: "trace" as const }]
          : []),
        ...(args.commsArtifactPath
          ? [{ label: "comms thread", path: args.commsArtifactPath, kind: "log" as const }]
          : []),
        ...(args.recording
          ? [{ label: "desktop recording", path: args.recording.path, kind: "recording" as const }]
          : []),
        ...args.screenshots.map((screenshot, index) => ({
          label: `screenshot ${String(index + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const,
        })),
      ],
    },
    args.participantId ?? "lane-01",
  );
}

function singleEvents(args: SingleParticipantBundleArgs, view: ParticipantView): RunEvent[] {
  const { publicAppUrl, desktopGeometry } = view;
  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "cua-lab.run.created",
      message: `Created computer-use lab run for ${args.labId} (actor ${args.actorId}).`,
    },
    args.subjectProvenance
      ? participantEvent(SINGLE, {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.provenance",
          // HONEST WORDING: claim "cloned/packed and served" only when it actually happened.
          message: `${subjectProvenanceMessage(args.subjectProvenance, publicAppUrl, args.dryRun, args.session !== undefined)} (subject env names: ${args.subjectProvenance.envNames.length > 0 ? args.subjectProvenance.envNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(args.subjectProvenance.state, args.dryRun)}.`,
        })
      : participantEvent(SINGLE, {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.declared",
          // Invariant 5: declare what the subject WAS, including the ABSENCE of a pin. A
          // local-app / in-process subject is an already-running LOCAL dev server the caller
          // provisioned; it cannot be commit-pinned, so its provenance is honestly UNPINNED and
          // no E2B desktop was created. A plain app-url entry runs inside the desktop sandbox, or,
          // on the local VM, reaches the host's loopback from the VM's browser.
          message:
            args.entryKind === "local-app"
              ? `Subject app declared at ${publicAppUrl} (already-running LOCAL dev server driven in-process; NO clone, NO E2B desktop). Provenance: caller-provisioned and UNPINNED — a running dev server cannot be commit-pinned.`
              : runnerSubstrate(args) === "local-desktop"
                ? `Subject app declared at ${publicAppUrl} (the host's loopback, opened from a browser on a local VM).`
                : `Subject app declared at ${publicAppUrl} (loopback inside the desktop sandbox).`,
        }),
    args.session
      ? participantEvent(SINGLE, {
          id: "event-002-session",
          at: args.createdAt,
          level: args.session.status === "passed" ? "info" : "warn",
          type: `cua-lab.session.${args.session.completionReason}`,
          message: `${args.session.status}: ${args.session.reason}`,
        })
      : args.inProgress === true
        ? participantEvent(SINGLE, {
            id: "event-002-running",
            at: args.createdAt,
            level: "info" as const,
            type: "cua-lab.session.running",
            message:
              "Live computer-use session is running; terminal evidence has not been written yet.",
          })
        : args.sessionError !== undefined
          ? participantEvent(SINGLE, {
              id: "event-002-session",
              at: args.createdAt,
              level: "error" as const,
              type: "cua-lab.session.error",
              message: args.sessionError,
            })
          : participantEvent(SINGLE, {
              id: "event-002-contract",
              at: args.createdAt,
              level: "info" as const,
              type: "cua-lab.contract.ready",
              message:
                "Dry-run contract bundle ready; switch scenario.mode to live for a real desktop session.",
            }),
  ];
  const record = (event: Omit<RunEvent, "simId" | "streamId">) =>
    events.push(participantEvent(SINGLE, event));

  // Persisted phase trail (real boot timing, not just a coarse provenance sentence): one
  // RunEvent per COMPLETED phase boundary (started events never persist here; they carry no
  // durationMs). ok:false phases warn rather than error, since the failing phase's own thrown
  // error already becomes the terminal cua-lab.session.error event above.
  let phaseEventSeq = 3;
  for (const phase of args.phaseEvents ?? []) {
    record({
      id: `event-${String(phaseEventSeq++).padStart(3, "0")}-phase-${phaseEventIdSuffix(phase.type)}`,
      at: phase.at,
      level: phase.ok === false ? "warn" : "info",
      type: phase.type,
      message:
        phase.durationMs === undefined ? phase.message : `${phase.message} (${phase.durationMs}ms)`,
    });
  }
  for (const warning of desktopGeometry?.warnings ?? []) {
    record({
      id: `event-${String(phaseEventSeq++).padStart(3, "0")}-geometry-warning`,
      at: args.createdAt,
      level: "warn",
      type: "cua-lab.geometry.warning",
      message: warning,
    });
  }
  return events;
}

function singleReview(
  args: SingleParticipantBundleArgs,
  view: ParticipantView,
  stream: RunStream,
): ReviewSummary {
  const { reason } = view;
  // A funnel with a denominator of one is still the funnel — and its absence stays honest: no
  // declared protocol (or a dry run) means no `tasks` field, never an empty one.
  const singleStudyTasks =
    args.inProgress !== true && args.session?.trace.taskFunnel !== undefined
      ? aggregateTaskFunnels([args.session.trace.taskFunnel])
      : undefined;
  // What happened to the participant, as the LANE judged it — the same rule the fan-out roll-up
  // applies (participantStatusForOutcome). Before #476 this read the actor's own status, so a
  // run the lane refused as "not a credible pass" was written up as verdict pass, 1/1 reached
  // the goal, and every projection of the bundle (Observer tally, `runs`, the status index)
  // repeated it. Found on a real drawDB run whose participant wrote "Blocked after partial
  // completion".
  const participantStatus: ActorStatus | undefined =
    args.session === undefined
      ? undefined
      : participantStatusFor(args.session.status, args.credibility);
  const credibilityNote =
    args.session === undefined || participantStatus === args.session.status
      ? undefined
      : args.credibility?.noEngagement === true
        ? "Not counted as a pass: the participant took no actions and said nothing."
        : "Not counted as a pass: the participant's final message described a blocker.";
  const review: ReviewSummary = withCuaReviewProvenance(
    {
      schema: REVIEW_SCHEMA,
      verdict: args.verdict,
      // One lane is still a study with a denominator of one, and saying so keeps a single-lane
      // result from being read as though it generalized.
      ...(participantStatus !== undefined && args.inProgress !== true
        ? {
            participants: tallyParticipantOutcomes(
              [participantStatus],
              [args.credibility?.reportedFriction === true],
            ),
          }
        : {}),
      ...(singleStudyTasks === undefined ? {} : { tasks: singleStudyTasks }),
      summary: credibilityNote === undefined ? reason : `${credibilityNote} ${reason}`,
      gaps:
        args.session || args.sessionError !== undefined
          ? []
          : args.inProgress === true
            ? ["Live desktop session is still running."]
            : ["Live desktop session not yet run (dry-run contract only)."],
    },
    [stream],
  );
  return review;
}

/**
 * The bundle of a single-participant run: one participant and no rerun. buildCuaRunBundle
 * (bundle.ts) maps the run's base and state into these arguments.
 */
export function buildSingleParticipantBundle(args: {
  /** The run's verdict, from the judge. */
  verdict: Verdict;
  realEmail?: boolean;
  /** Lab provenance for the bundle's own `lab` field (#455). */
  lab?: RunLabProvenance;
  actorId: string;
  appUrl: string;
  /** The participant's plan id, saved as the stream's laneId ("lane-01" when absent). */
  participantId?: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  createdAt: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  assignment?: RunStream["assignment"];
  persona: ActorPersonaRef;
  resolution: [number, number];
  /** False only for the custom in-process route, which has no hosted screen/window to claim. */
  desktopRoute?: boolean;
  /** The participant's runner; see runnerSubstrate for the default. */
  substrate?: RunFeedbackCandidate["substrate"];
  /** Runtime screen/window/viewport evidence. `viewport` inside this object must be measured. */
  desktopGeometry?: RunDesktopGeometry;
  recording?: RunDesktopRecording;
  /** Device-preset touch metadata echoed on the measured stream viewport (a prompt signal on
   *  this route, never a rendered claim); the measured width/height/DPR stay authoritative. */
  isMobile?: boolean;
  runId: string;
  screenshots: string[];
  /** Relative run-dir path of the digest-only comms-thread evidence artifact (humanish.comms-thread.v1),
   *  when a comms lab captured mail; registered as a "log" stream artifact. */
  commsArtifactPath?: string;
  /**
   * Capture-time screenshot policy ("blurred" when policies.redactScreenshots, else "raw").
   * When a session ran, its trace's `redaction.screenshots` is the evidence-of-record and
   * wins; this fallback keeps labels honest for frames written before a mid-session failure
   * (no trace exists to testify then). Defaults to "raw" — the engine default.
   */
  captureRedaction?: "raw" | "blurred";
  session?: CuaLoopResult;
  sessionError?: string;
  /**
   * The lane's own credibility read of a goal_satisfied session (#476). The actor's status is
   * evidence of what it CLAIMED; whether the harness counts the claim is decided by the lane
   * (zero engagement, a final message that describes a blocker). The review has to say the same
   * thing the lane's exit code says, or the durable bundle reports a participant reaching the
   * goal on a run the harness refused to count.
   */
  credibility?: { noEngagement: boolean; selfReportedBlocker: boolean; reportedFriction: boolean };
  source: RunBundle["source"];
  /** Provisioned-route provenance (clone or local-tree): what the actor actually drove (names
   * + digests only, never values or command text), including the subject's state story. */
  subjectProvenance?: CuaSubjectProvenanceArg;
  /**
   * Entry kind for the non-clone subject.declared event (invariant 5 — declare what the subject
   * WAS). "local-app": an already-running LOCAL dev server driven in-process, un-pinnable —
   * declared honestly as caller-provisioned/unpinned with no E2B. Absent: a plain app-url entry.
   */
  entryKind?: "local-app";
  /** The custom E2B desktop template (image) this lane launched on, when configured (provenance). */
  desktopTemplate?: string;
  /** The configured browser choice and the command that opened, when explicitly configured. */
  desktopBrowser?: DesktopBrowserEvidence;
  traceArtifactPath?: string;
  providerResources?: RunProviderResource[];
  inProgress?: boolean;
  /** Completed subject-phase records (clone/upload/extract/install/build/ready/state groups)
   *  to fold into bundle.events, so run.json carries real phase timing after the fact. */
  phaseEvents?: SubjectPhaseEvent[];
  /** Host-side E2B desktop billed span for this lane, in minutes (from ParticipantRunOutcome
   *  desktopDurationMs). Absent when no sandbox ran (in-process/dry-run) → no desktop cost line. */
  desktopMinutes?: number;
  desktopUsage?: DesktopUsage;
}): RunBundle {
  const publicAppUrl = publicSafeAppUrlLabel(args.appUrl);
  const cost = runCost(args);
  const view = participantView(args, publicAppUrl);
  const { traceScreenshotMode, screenshotMode } = view;
  const simulation = singleSimulation(args, view);
  const stream = singleStream(args, view);
  const events = singleEvents(args, view);
  const review = singleReview(args, view, stream);

  return {
    ...bundleHead({
      ...(args.realEmail && !args.dryRun
        ? { publication: { restrictions: ["real-communications"] as ["real-communications"] } }
        : {}),
      runId: args.runId,
      mode: args.dryRun ? "dry-run" : "live",
      participants: 1,
      createdAt: args.createdAt,
      ...(args.lab === undefined ? {} : { lab: args.lab }),
      source: args.source,
    }),
    persona: {
      id: args.persona.id,
      name: `Computer-use operator (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest,
    },
    scenario: {
      id: `cua-${args.labId}`,
      title: args.labTitle ?? `Computer-use lab: ${args.labId}`,
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest,
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use lab run with one desktop browser lane (actor ${args.actorId}).`,
      },
    ],
    simulations: [simulation],
    streams: [stream],
    events,
    redaction: {
      status: "passed",
      notes:
        traceScreenshotMode === "raw"
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
          : traceScreenshotMode === "blurred"
            ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
            : args.screenshots.length > 0
              ? `Session ended before a trace was recorded; ${args.screenshots.length} already-written frame(s) follow the capture policy (${screenshotMode}). Typed text is recorded as length only and reasoning/messages pass through text redaction.`
              : "No screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs.",
    },
    artifacts: bundleArtifacts(),
    review,
    // What the participant reported, when it reported anything (#392). Dry-run and in-progress
    // bundles carry none — there is no participant yet to quote.
    feedbackCandidates:
      args.dryRun || args.inProgress === true
        ? []
        : participantFeedbackCandidates({
            runId: args.runId,
            scenarioId: `cua-${args.labId}`,
            adapterId: args.labId,
            goal: redactText(args.mission),
            substrate: runnerSubstrate(args),
            participants: [
              {
                participantId: args.participantId ?? "lane-01",
                streamId: SINGLE.streamId,
                personaId: args.persona.id,
                ...(args.session === undefined ? {} : { session: args.session }),
                ...(args.traceArtifactPath === undefined
                  ? {}
                  : { traceArtifactPath: args.traceArtifactPath }),
                screenshots: args.screenshots,
                ...(args.commsArtifactPath === undefined
                  ? {}
                  : { commsArtifactPath: args.commsArtifactPath }),
              },
            ],
          }),
    // Custom desktop image provenance (omitted on the stock-template default → byte-stable).
    ...(args.desktopTemplate === undefined ? {} : { desktopTemplate: args.desktopTemplate }),
    ...(args.desktopBrowser === undefined ? {} : { desktopBrowser: args.desktopBrowser }),
    ...(args.providerResources === undefined || args.providerResources.length === 0
      ? {}
      : { providerResources: args.providerResources }),
    // Structured subject provenance (invariant 5): code pin + state story. Uniform and
    // honest on app-url bundles too — the caller minted the URL, its state is the caller's.
    // CuaSubjectProvenanceArg's two variants (clone, local-tree) are already RunSubjectProvenance-
    // shaped, so no reconstruction is needed beyond the app-url fallback.
    subject: args.subjectProvenance ?? { source: "app-url", state: { provenance: "undeclared" } },
    ...(cost === undefined ? {} : { cost }),
  };
}
