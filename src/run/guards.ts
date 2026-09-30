import { isCommsReceivingEvidence } from "../comms/receiving-evidence.js";
import {
  desktopRecordingMetadataSchema,
  type RunDesktopRecording,
} from "../evidence/desktop-recording-types.js";
import path from "node:path";
import { GIT_STATE_SCHEMA, type CapturedGitState } from "./git-state.js";
import {
  CLEANUP_SCHEMA,
  type CleanupAdapterResult,
  type CleanupResourceResult,
  type CleanupResult,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  type ReviewSummary,
  RUN_BUNDLE_SCHEMA,
  type RunAdapterArtifact,
  type RunAdapterScore,
  type RunBundle,
  type RunDesktopGeometry,
  type RunEvent,
  type RunParticipantAssignment,
  type RunPointer,
  type RunProviderResource,
  type RunRerunLineage,
  type RunScorerProvenance,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
  type RunStreamKind,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "./bundle.js";
import { isRunFeedbackCandidate } from "./guards-feedback.js";
import { isSharedWorldEvidence } from "./guards-shared-world.js";
import {
  isFiniteNumber,
  isNonNegativeSafeInteger,
  isPositiveFiniteNumber,
  isPositiveSafeInteger,
  isRecord,
} from "./primitives.js";

const SAFE_GIT_NOTES = new Set([
  "Git command could not be started.",
  "Git HEAD capture timed out.",
  "Git HEAD command could not be started.",
  "Git metadata could not be inspected safely.",
  "Git status command could not be captured.",
  "Git status command could not be started.",
  "Git status could not be captured.",
  "Git status capture timed out.",
  "Git metadata failed containment validation.",
  "Git ref-state capture timed out.",
  "Git ref-state command could not be started.",
  "Git work-tree detection timed out.",
  "Git work tree had changes; only counts were captured, not branch names, remotes, paths, or file names.",
  "Git work tree was clean; branch names, remotes, paths, and file names were not captured.",
  "No git work tree was detected.",
  "public-safe synthetic fixture",
  "public-safe synthetic OSS meta-lab fixture",
]);

const riskyPublicArtifactPathSegments = new Set([
  ".git",
  "Cookies",
  "Login Data",
  "Local Storage",
  "Preferences",
  "Secure Preferences",
  "profiles",
]);

export function isRiskyPublicArtifactPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => riskyPublicArtifactPathSegments.has(segment));
}

export function isLocalEvidenceArtifactPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return (
    value.length > 0 &&
    !/^\[[a-z0-9._-]+\]$/i.test(normalized) &&
    !path.isAbsolute(normalized) &&
    !normalized.includes("://") &&
    !normalized.startsWith("..") &&
    !normalized.split("/").includes("..") &&
    !isRiskyPublicArtifactPath(normalized)
  );
}

export function isRunBundle(value: unknown): value is RunBundle {
  return (
    isRecord(value) &&
    value.schema === RUN_BUNDLE_SCHEMA &&
    (value.commsReceiving === undefined || isCommsReceivingEvidence(value.commsReceiving)) &&
    (value.publication === undefined ||
      (isRecord(value.publication) &&
        Array.isArray(value.publication.restrictions) &&
        value.publication.restrictions.length === 1 &&
        value.publication.restrictions[0] === "real-communications")) &&
    typeof value.runId === "string" &&
    (value.mode === "dry-run" || value.mode === "live") &&
    isPositiveSafeInteger(value.simCount) &&
    typeof value.createdAt === "string" &&
    value.cwd === PUBLIC_TARGET_CWD &&
    typeof value.artifactRoot === "string" &&
    isRunSource(value.source) &&
    isPersonaSummary(value.persona) &&
    isScenarioSummary(value.scenario) &&
    Array.isArray(value.lifecycle) &&
    value.lifecycle.every(isLifecycleEvent) &&
    Array.isArray(value.simulations) &&
    value.simulations.length === value.simCount &&
    value.simulations.every(isRunSimulation) &&
    Array.isArray(value.streams) &&
    value.streams.every(isRunStream) &&
    hasConsistentSimulationStreams(value.simulations, value.streams) &&
    Array.isArray(value.events) &&
    value.events.every(isRunEvent) &&
    isRunArtifactIndex(value.artifacts) &&
    isRecord(value.review) &&
    isReviewSummary(value.review) &&
    isRecord(value.redaction) &&
    value.redaction.status === "passed" &&
    Array.isArray(value.feedbackCandidates) &&
    value.feedbackCandidates.every(isRunFeedbackCandidate) &&
    // Optional and additive: pre-existing bundles (and non-cua backends) carry no subject
    // block; when present it must be well-shaped (semantics are the verify check's job).
    (value.subject === undefined || isRunSubjectProvenance(value.subject)) &&
    (value.desktopBrowser === undefined || isDesktopBrowserEvidence(value.desktopBrowser)) &&
    (value.rerun === undefined || isRunRerunLineage(value.rerun)) &&
    // Optional + additive shared-world fields (#164). Tolerant SHAPE guard only — the interaction
    // semantics (timeline well-formedness, single-plane, delta-on-pass) are the verify check's job.
    (value.attributionClass === undefined ||
      value.attributionClass === "isolated" ||
      value.attributionClass === "shared-world") &&
    (value.sharedWorld === undefined || isSharedWorldEvidence(value.sharedWorld)) &&
    // Optional, adapter-namespaced product score (the extension seam). When present, validate only
    // its SHAPE; core never reads the adapter's `data` payload.
    (value.adapterScore === undefined || isRunAdapterScore(value.adapterScore)) &&
    // Optional + additive scorer provenance (#316). Tolerated-absent so pre-#316 and library-caller
    // bundles still verify; when present it must be well-shaped.
    (value.scorerProvenance === undefined || isRunScorerProvenance(value.scorerProvenance)) &&
    (value.adapterArtifacts === undefined ||
      (Array.isArray(value.adapterArtifacts) &&
        value.adapterArtifacts.every(isRunAdapterArtifact))) &&
    (value.providerResources === undefined ||
      (Array.isArray(value.providerResources) &&
        value.providerResources.every(isRunProviderResource)))
  );
}

function isRunProviderResource(value: unknown): value is RunProviderResource {
  return (
    isRecord(value) &&
    value.schema === "humanish.provider-resource.v1" &&
    value.provider === "e2b-desktop" &&
    value.kind === "sandbox" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.owner === "humanish" &&
    (value.status === "running" || value.status === "killed" || value.status === "unknown") &&
    (value.simId === undefined || typeof value.simId === "string") &&
    (value.streamId === undefined || typeof value.streamId === "string") &&
    (value.laneId === undefined || typeof value.laneId === "string") &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    (value.cleanup === undefined ||
      (isRecord(value.cleanup) &&
        typeof value.cleanup.killed === "boolean" &&
        typeof value.cleanup.reason === "string"))
  );
}

export function isCleanupResult(value: unknown): value is CleanupResult {
  return (
    isRecord(value) &&
    value.schema === CLEANUP_SCHEMA &&
    typeof value.ok === "boolean" &&
    typeof value.cwd === "string" &&
    typeof value.run === "string" &&
    typeof value.checkedAt === "string" &&
    (value.runId === undefined || typeof value.runId === "string") &&
    (value.bundlePath === undefined || typeof value.bundlePath === "string") &&
    (value.cleanupPath === undefined || typeof value.cleanupPath === "string") &&
    isRecord(value.summary) &&
    isNonNegativeSafeInteger(value.summary.resources) &&
    isNonNegativeSafeInteger(value.summary.killed) &&
    isNonNegativeSafeInteger(value.summary.alreadyClean) &&
    isNonNegativeSafeInteger(value.summary.failed) &&
    isNonNegativeSafeInteger(value.summary.skipped) &&
    Array.isArray(value.resources) &&
    value.resources.every(isCleanupResourceResult) &&
    Array.isArray(value.adapterResults) &&
    value.adapterResults.every(isCleanupAdapterResult) &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string")
  );
}

function isCleanupResourceResult(value: unknown): value is CleanupResourceResult {
  return (
    isRecord(value) &&
    value.provider === "e2b-desktop" &&
    value.kind === "sandbox" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    (value.status === "killed" ||
      value.status === "already_clean" ||
      value.status === "failed" ||
      value.status === "skipped") &&
    typeof value.message === "string"
  );
}

function isCleanupAdapterResult(value: unknown): value is CleanupAdapterResult {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.ok === "boolean" &&
    typeof value.message === "string"
  );
}

function isRunRerunLineage(value: unknown): value is RunRerunLineage {
  return (
    isRecord(value) &&
    typeof value.sourceRunId === "string" &&
    value.sourceRunId.trim().length > 0 &&
    Array.isArray(value.selectedLaneIds) &&
    value.selectedLaneIds.length > 0 &&
    value.selectedLaneIds.every(
      (laneId) => typeof laneId === "string" && laneId.trim().length > 0,
    ) &&
    Array.isArray(value.previous) &&
    value.previous.length > 0 &&
    value.previous.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.laneId === "string" &&
        entry.laneId.trim().length > 0 &&
        (entry.streamId === undefined || typeof entry.streamId === "string") &&
        typeof entry.status === "string" &&
        entry.status.trim().length > 0 &&
        (entry.reason === undefined || typeof entry.reason === "string") &&
        (entry.actorStatus === undefined || typeof entry.actorStatus === "string") &&
        (entry.completionReason === undefined || typeof entry.completionReason === "string"),
    )
  );
}

function isDesktopBrowserEvidence(value: unknown): value is RunBundle["desktopBrowser"] {
  return (
    isRecord(value) &&
    (value.requested === "default" ||
      value.requested === "chrome" ||
      value.requested === "chromium" ||
      value.requested === "firefox") &&
    (value.resolved === undefined || typeof value.resolved === "string")
  );
}

/** Short lowercase-hex content digest (digestText default is 12 chars; tolerate longer future digests). */
const SCORER_DIGEST_PATTERN = /^[a-f0-9]{12,64}$/;

/** Shape guard for RunScorerProvenance (#316), mirroring isRunSubjectProvenance: tolerated-absent in
 *  isRunBundle, well-shaped when present. Semantics (does the digest still match the file) are not a
 *  verify concern — the block is core-stamped evidence of what was loaded, not a re-execution proof. */
function isRunScorerProvenance(value: unknown): value is RunScorerProvenance {
  return (
    isRecord(value) &&
    value.schema === "humanish.scorer-provenance.v1" &&
    typeof value.ref === "string" &&
    value.ref.trim().length > 0 &&
    typeof value.digest === "string" &&
    SCORER_DIGEST_PATTERN.test(value.digest) &&
    (value.source === "manifest" || value.source === "cli-flag") &&
    Array.isArray(value.exports) &&
    value.exports.length > 0 &&
    value.exports.every(
      (name) => name === "score" || name === "deriveFeedback" || name === "deriveArtifacts",
    )
  );
}

function isRunAdapterScore(value: unknown): value is RunAdapterScore {
  return (
    isRecord(value) &&
    value.schema === "humanish.adapter-score.v1" &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    (value.status === "pass" || value.status === "partial" || value.status === "fail") &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    typeof value.summary === "string" &&
    (value.data === undefined || isRecord(value.data))
  );
}

// The local-tree archive content pin: sha256 hex, full 64 chars (NOT the repo's 16-char
// display-digest convention -- this value is the provenance pin itself, persisted in full).
export const ARCHIVE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRunSubjectProvenance(value: unknown): value is RunSubjectProvenance {
  if (!isRecord(value)) return false;
  if (value.source !== "clone" && value.source !== "app-url" && value.source !== "local-tree")
    return false;
  if (value.repo !== undefined && typeof value.repo !== "string") return false;
  if (value.commit !== undefined && typeof value.commit !== "string") return false;
  if (
    value.archiveSha256 !== undefined &&
    (typeof value.archiveSha256 !== "string" || !ARCHIVE_SHA256_PATTERN.test(value.archiveSha256))
  ) {
    return false;
  }
  if (value.dirty !== undefined && typeof value.dirty !== "boolean") return false;
  if (
    value.envNames !== undefined &&
    !(Array.isArray(value.envNames) && value.envNames.every((name) => typeof name === "string"))
  ) {
    return false;
  }
  const state = value.state;
  if (!isRecord(state)) return false;
  if (
    state.provenance !== "seeded" &&
    state.provenance !== "unpinned" &&
    state.provenance !== "declared-not-run" &&
    state.provenance !== "undeclared" &&
    state.provenance !== "external-public"
  ) {
    return false;
  }
  if (
    state.seed !== undefined &&
    !(Array.isArray(state.seed) && state.seed.every(isRunSubjectStateStepRecord))
  ) {
    return false;
  }
  if (
    state.externalEnvNames !== undefined &&
    !(
      Array.isArray(state.externalEnvNames) &&
      state.externalEnvNames.every((name) => typeof name === "string")
    )
  ) {
    return false;
  }
  return true;
}

function isRunSubjectStateStepRecord(value: unknown): value is RunSubjectStateStepRecord {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.when === "before-build" ||
      value.when === "before-start" ||
      value.when === "after-ready") &&
    typeof value.commandDigest === "string" &&
    (value.ok === undefined || typeof value.ok === "boolean") &&
    (value.exitCode === undefined || typeof value.exitCode === "number") &&
    (value.timedOut === undefined || typeof value.timedOut === "boolean") &&
    (value.durationMs === undefined || typeof value.durationMs === "number")
  );
}

function isRunSource(value: unknown): value is RunBundle["source"] {
  return (
    isRecord(value) &&
    (typeof value.packageName === "string" || value.packageName === null) &&
    (value.humanishSource === "present" || value.humanishSource === "missing") &&
    isCapturedGitState(value.git)
  );
}

function isCapturedGitState(value: unknown): value is CapturedGitState {
  return (
    isRecord(value) &&
    value.schema === GIT_STATE_SCHEMA &&
    (value.status === "clean" ||
      value.status === "dirty" ||
      value.status === "missing" ||
      value.status === "unavailable") &&
    typeof value.capturedAt === "string" &&
    isRecord(value.head) &&
    (isSafeGitShortSha(value.head.shortSha) || value.head.shortSha === null) &&
    (value.head.refState === "attached" ||
      value.head.refState === "detached" ||
      value.head.refState === "unborn" ||
      value.head.refState === "unknown") &&
    isRecord(value.changes) &&
    isNonNegativeSafeInteger(value.changes.staged) &&
    isNonNegativeSafeInteger(value.changes.unstaged) &&
    isNonNegativeSafeInteger(value.changes.untracked) &&
    isNonNegativeSafeInteger(value.changes.total) &&
    typeof value.note === "string" &&
    SAFE_GIT_NOTES.has(value.note)
  );
}

function isPersonaSummary(value: unknown): value is RunBundle["persona"] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    typeof value.sourceDigest === "string"
  );
}

function isScenarioSummary(value: unknown): value is RunBundle["scenario"] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.source === "string" &&
    typeof value.sourceDigest === "string"
  );
}

function isLifecycleEvent(value: unknown): value is RunBundle["lifecycle"][number] {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.event === "string" &&
    typeof value.message === "string"
  );
}

function isRunSimulation(value: unknown): value is RunSimulation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isPositiveSafeInteger(value.index) &&
    typeof value.personaId === "string" &&
    typeof value.scenarioId === "string" &&
    isRunSimulationStatus(value.status) &&
    isRunStreamKind(value.streamKind) &&
    (value.mode === "browser-sim" ||
      value.mode === "cli-sim" ||
      value.mode === "tui-sim" ||
      value.mode === "codex-app-sim") &&
    typeof value.progress === "number" &&
    typeof value.currentStep === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.streamIds) &&
    value.streamIds.every((streamId) => typeof streamId === "string") &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRunStream(value: unknown): value is RunStream {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.simId === "string" &&
    isRunStreamKind(value.kind) &&
    typeof value.label === "string" &&
    isRunSimulationStatus(value.status) &&
    (value.transport === "snapshot" ||
      value.transport === "polling" ||
      value.transport === "sse" ||
      value.transport === "pty" ||
      value.transport === "app-server") &&
    typeof value.updatedAt === "string" &&
    (value.assignment === undefined || isRunParticipantAssignment(value.assignment)) &&
    (value.viewport === undefined || isRunViewport(value.viewport)) &&
    (value.desktopGeometry === undefined || isRunDesktopGeometry(value.desktopGeometry)) &&
    (value.recording === undefined || isRunDesktopRecording(value.recording)) &&
    hasConsistentStreamGeometry(value) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isRunStreamArtifact) &&
    hasConsistentRecordingArtifact(value.recording, value.artifacts)
  );
}

function hasConsistentRecordingArtifact(
  recording: RunDesktopRecording | undefined,
  artifacts: RunStream["artifacts"],
): boolean {
  const files = artifacts.filter((artifact) => artifact.kind === "recording");
  return recording ? files.length === 1 && files[0]!.path === recording.path : files.length === 0;
}

function isRunDesktopRecording(value: unknown): value is RunDesktopRecording {
  if (
    !isRecord(value) ||
    value.schema !== "humanish.desktop-recording.v1" ||
    typeof value.path !== "string" ||
    !isLocalEvidenceArtifactPath(value.path) ||
    !/^recordings\/[-A-Za-z0-9_.]+\/desktop\.mp4$/.test(value.path)
  )
    return false;
  const { schema: _schema, path: _path, ...metadata } = value;
  return desktopRecordingMetadataSchema.safeParse(metadata).success;
}

function isRunParticipantAssignment(value: unknown): value is RunParticipantAssignment {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "mission" || key === "focus" || key === "tasks") &&
    typeof value.mission === "string" &&
    (value.focus === undefined || typeof value.focus === "string") &&
    (value.tasks === undefined ||
      (Array.isArray(value.tasks) &&
        value.tasks.every(
          (task) =>
            isRecord(task) &&
            Object.keys(task).every((key) => key === "id" || key === "goal") &&
            typeof task.id === "string" &&
            typeof task.goal === "string",
        )))
  );
}

function isRunViewport(value: unknown): value is NonNullable<RunStream["viewport"]> {
  return (
    isRecord(value) &&
    isPositiveFiniteNumber(value.width) &&
    isPositiveFiniteNumber(value.height) &&
    (value.deviceScaleFactor === undefined || isPositiveFiniteNumber(value.deviceScaleFactor)) &&
    (value.isMobile === undefined || typeof value.isMobile === "boolean")
  );
}

function isRunDesktopGeometry(value: unknown): value is RunDesktopGeometry {
  if (!isRecord(value) || !isRecord(value.screen) || !isMeasuredSize(value.screen.requested)) {
    return false;
  }
  const verified = value.screen.verified;
  if (verified !== undefined) {
    if (!isRecord(verified)) return false;
    const source = verified.source;
    if (!isMeasuredSize(verified) || source !== "xdpyinfo") return false;
  }
  const declared = value.screen.declared;
  if (declared !== undefined) {
    if (!isRecord(declared)) return false;
    // read before isMeasuredSize narrows `declared` to {width, height}
    const preset = declared.preset;
    if (!isMeasuredSize(declared) || typeof preset !== "string") return false;
  }
  const browserWindow = value.browserWindow;
  if (
    browserWindow !== undefined &&
    (!isRecord(browserWindow) ||
      !isFiniteNumber(browserWindow.x) ||
      !isFiniteNumber(browserWindow.y) ||
      !isPositiveFiniteNumber(browserWindow.width) ||
      !isPositiveFiniteNumber(browserWindow.height) ||
      (browserWindow.source !== "cdp" &&
        browserWindow.source !== "xdotool" &&
        browserWindow.source !== "xwininfo"))
  ) {
    return false;
  }
  const viewport = value.viewport;
  if (
    !(
      viewport === undefined ||
      (isRecord(viewport) &&
        isPositiveFiniteNumber(viewport.width) &&
        isPositiveFiniteNumber(viewport.height) &&
        isPositiveFiniteNumber(viewport.deviceScaleFactor) &&
        viewport.source === "cdp")
    )
  )
    return false;
  return (
    value.warnings === undefined ||
    (Array.isArray(value.warnings) &&
      value.warnings.every((warning) => typeof warning === "string" && warning.length > 0))
  );
}

function hasConsistentStreamGeometry(value: Record<string, unknown>): boolean {
  if (value.desktopGeometry === undefined) return true;
  if (!isRunDesktopGeometry(value.desktopGeometry)) return false;
  const measured = value.desktopGeometry.viewport;
  if (measured === undefined) return value.viewport === undefined;
  if (!isRunViewport(value.viewport)) return false;
  return (
    value.viewport.width === measured.width &&
    value.viewport.height === measured.height &&
    value.viewport.deviceScaleFactor === measured.deviceScaleFactor
  );
}

function isMeasuredSize(value: unknown): value is { width: number; height: number } {
  return (
    isRecord(value) && isPositiveFiniteNumber(value.width) && isPositiveFiniteNumber(value.height)
  );
}

function isRunStreamArtifact(value: unknown): value is RunStream["artifacts"][number] {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.path === "string" &&
    (value.kind === "bundle" ||
      value.kind === "review" ||
      value.kind === "observer" ||
      value.kind === "events" ||
      value.kind === "screenshot" ||
      value.kind === "trace" ||
      value.kind === "log" ||
      value.kind === "filesystem" ||
      value.kind === "recording")
  );
}

function isRunAdapterArtifact(value: unknown): value is RunAdapterArtifact {
  return (
    isRecord(value) &&
    value.schema === "humanish.adapter-artifact.v1" &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    typeof value.label === "string" &&
    value.label.trim().length > 0 &&
    typeof value.path === "string" &&
    value.path.trim().length > 0 &&
    isLocalEvidenceArtifactPath(value.path) &&
    (value.kind === "state" ||
      value.kind === "review" ||
      value.kind === "log" ||
      value.kind === "trace" ||
      value.kind === "screenshot" ||
      value.kind === "filesystem" ||
      value.kind === "summary") &&
    typeof value.note === "string" &&
    value.note.trim().length > 0
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}

function isRunArtifactIndex(value: unknown): value is RunBundle["artifacts"] {
  return (
    isRecord(value) &&
    typeof value.run === "string" &&
    typeof value.reviewJson === "string" &&
    typeof value.reviewMarkdown === "string" &&
    typeof value.observerData === "string" &&
    typeof value.events === "string"
  );
}

function hasConsistentSimulationStreams(simulations: unknown[], streams: unknown[]): boolean {
  const simIds = new Set<string>();
  const expectedStreamSimIds = new Map<string, string>();
  const streamById = new Map<string, RunStream>();

  for (const simulation of simulations) {
    if (!isRunSimulation(simulation)) {
      return false;
    }

    simIds.add(simulation.id);
    for (const streamId of simulation.streamIds) {
      if (expectedStreamSimIds.has(streamId)) {
        return false;
      }

      expectedStreamSimIds.set(streamId, simulation.id);
    }
  }

  for (const stream of streams) {
    if (!isRunStream(stream) || !simIds.has(stream.simId) || streamById.has(stream.id)) {
      return false;
    }

    const expectedSimId = expectedStreamSimIds.get(stream.id);
    if (expectedSimId === undefined || stream.simId !== expectedSimId) {
      return false;
    }

    streamById.set(stream.id, stream);
  }

  return streamById.size === expectedStreamSimIds.size;
}

function isRunSimulationStatus(value: unknown): value is RunSimulationStatus {
  return (
    value === "queued" ||
    value === "preparing" ||
    value === "running" ||
    value === "passed" ||
    // Participant outcomes (docs/principles/three-roles.md). This runtime allowlist is the actual
    // gate — the TS union alone does not validate a bundle read back from disk.
    value === "abandoned" ||
    value === "incomplete" ||
    value === "complete" ||
    value === "blocked" ||
    value === "timed_out" ||
    value === "failed" ||
    value === "contract_proof_only"
  );
}

function isRunStreamKind(value: unknown): value is RunStreamKind {
  return (
    value === "ui" ||
    value === "browser" ||
    value === "terminal" ||
    value === "tui" ||
    value === "codex-ui" ||
    value === "artifact" ||
    value === "summary"
  );
}

function isSafeGitShortSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,12}$/.test(value);
}

export function isReviewSummary(value: unknown): value is ReviewSummary {
  return (
    isRecord(value) &&
    value.schema === REVIEW_SCHEMA &&
    (value.verdict === "contract_proof_only" ||
      value.verdict === "pass" ||
      value.verdict === "fail" ||
      value.verdict === "blocked" ||
      value.verdict === "timed_out") &&
    typeof value.summary === "string" &&
    Array.isArray(value.gaps) &&
    value.gaps.every((gap) => typeof gap === "string")
  );
}

export function isRunPointer(value: unknown): value is RunPointer {
  return (
    isRecord(value) &&
    value.schema === "humanish.latest-run.v1" &&
    typeof value.runId === "string" &&
    typeof value.path === "string" &&
    typeof value.updatedAt === "string"
  );
}
