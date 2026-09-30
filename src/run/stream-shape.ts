// Shape guards for the streams[] records of run.json and their geometry, recording and artifacts.

import {
  desktopRecordingMetadataSchema,
  type RunDesktopRecording,
} from "../evidence/desktop-recording-types.js";
import { isLocalEvidenceArtifactPath } from "./paths.js";
import {
  type RunDesktopGeometry,
  type RunParticipantAssignment,
  type RunSimulationStatus,
  type RunStream,
  type RunStreamKind,
} from "./streams.js";
import { isFiniteNumber, isPositiveFiniteNumber, isRecord } from "./type-guards.js";

export function isRunStream(value: unknown): value is RunStream {
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

export function isRunSimulationStatus(value: unknown): value is RunSimulationStatus {
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

export function isRunStreamKind(value: unknown): value is RunStreamKind {
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
