export const CORE_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
export const LATEST_POINTER_SCHEMA = "humanish.latest-run.v1";
export const HISTORY_ENTRY_SCHEMA = "humanish.run-history-entry.v1";

export type CoreRunMode = "dry-run" | "live";

export interface BuildRunIdOptions {
  prefix: string;
  createdAt: Date | string;
  entropy: string;
}

export interface ArtifactLayout {
  artifactRoot: string;
  run: string;
  reviewJson: string;
  reviewMarkdown: string;
  observerData: string;
  events: string;
  latestPointer: string;
}

export interface LatestRunPointer {
  schema: typeof LATEST_POINTER_SCHEMA;
  runId: string;
  path: string;
  updatedAt: string;
}

export interface RunHistoryEntry {
  schema: typeof HISTORY_ENTRY_SCHEMA;
  runId: string;
  createdAt: string;
  mode: CoreRunMode;
  path: string;
}

export interface CoreLifecycleEvent {
  at: string;
  event: string;
  message: string;
}

export interface TimingSummary {
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "complete";
}

export function buildRunId(options: BuildRunIdOptions): string {
  const prefix = toSafeSegment(options.prefix, "run");
  const entropy = toSafeSegment(options.entropy, "proof");
  const timestamp = toTimestampSegment(options.createdAt);
  const runId = `${prefix}-${timestamp}-${entropy}`;

  assertRunId(runId);
  return runId;
}

export function isValidRunId(value: string): boolean {
  return CORE_RUN_ID_PATTERN.test(value) && !value.includes("--");
}

export function assertRunId(value: string): void {
  if (!isValidRunId(value)) {
    throw new Error(`Invalid run id: ${value}`);
  }
}

export function buildArtifactLayout(runId: string, runsRoot = ".humanish/runs"): ArtifactLayout {
  assertRunId(runId);

  const normalizedRoot = normalizeRelativePath(runsRoot);
  const artifactRoot = `${normalizedRoot}/${runId}`;

  return {
    artifactRoot,
    run: `${artifactRoot}/run.json`,
    reviewJson: `${artifactRoot}/review.json`,
    reviewMarkdown: `${artifactRoot}/review.md`,
    observerData: `${artifactRoot}/observer/observer-data.json`,
    events: `${artifactRoot}/events.ndjson`,
    latestPointer: `${normalizedRoot}/latest.json`
  };
}

export function createLatestPointer(options: {
  runId: string;
  artifactRoot: string;
  updatedAt: Date | string;
}): LatestRunPointer {
  assertRunId(options.runId);

  return {
    schema: LATEST_POINTER_SCHEMA,
    runId: options.runId,
    path: normalizeRelativePath(options.artifactRoot),
    updatedAt: toIsoString(options.updatedAt)
  };
}

export function createHistoryEntry(options: {
  runId: string;
  createdAt: Date | string;
  mode: CoreRunMode;
  artifactRoot: string;
}): RunHistoryEntry {
  assertRunId(options.runId);

  return {
    schema: HISTORY_ENTRY_SCHEMA,
    runId: options.runId,
    createdAt: toIsoString(options.createdAt),
    mode: options.mode,
    path: normalizeRelativePath(options.artifactRoot)
  };
}

export function createLifecycleEvent(options: {
  at: Date | string;
  event: string;
  message: string;
}): CoreLifecycleEvent {
  const event = options.event.trim();
  const message = options.message.trim();

  if (event.length === 0) {
    throw new Error("Lifecycle event is required.");
  }

  if (message.length === 0) {
    throw new Error("Lifecycle message is required.");
  }

  return {
    at: toIsoString(options.at),
    event,
    message
  };
}

export function summarizeTiming(options: {
  startedAt: Date | string;
  endedAt?: Date | string;
}): TimingSummary {
  const startedAt = toIsoString(options.startedAt);

  if (options.endedAt === undefined) {
    return {
      startedAt,
      endedAt: null,
      durationMs: null,
      status: "running"
    };
  }

  const endedAt = toIsoString(options.endedAt);
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  if (durationMs < 0) {
    throw new Error("Timing summary endedAt must be after startedAt.");
  }

  return {
    startedAt,
    endedAt,
    durationMs,
    status: "complete"
  };
}

function toTimestampSegment(value: Date | string): string {
  return toIsoString(value).toLowerCase().replace(/[:.]/g, "-");
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${String(value)}`);
  }

  return date.toISOString();
}

function toSafeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");

  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Artifact paths must be relative: ${value}`);
  }

  const parts = normalized.split("/").filter((part) => part.length > 0);

  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Artifact path contains an unsafe segment: ${value}`);
  }

  return parts.join("/");
}
