import path from "node:path";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  resolveExistingRunDirectory,
  resolveLatestRunDirectory,
  RUNS_RELATIVE_ROOT,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  ContainedReadRefusedError,
  LATEST_POINTER_MAX_BYTES,
  readContainedRegularFile,
  RUN_ARTIFACT_MAX_BYTES,
  type ContainedRefusal,
  type PreparedSelectedOutputDirectory,
} from "./contained-output.js";
import type { RunPointer } from "./results.js";
import { RUN_BUNDLE_FILE, type RunBundle } from "./bundle.js";
import { isRunBundle, isRunPointer } from "./bundle-shape.js";
import { readBoundedFileResult, type BoundedFileResult } from "./evidence-files.js";

/** The run input that resolves through latest.json rather than naming a run directory. */
export const LATEST_RUN_ALIAS = "latest";

/** Resolve "latest" or an explicit run id to its prepared artifact paths. */
export async function resolveRunPath(
  cwd: string,
  runInput: string,
): Promise<PreparedRunArtifactPaths | null> {
  if (runInput === LATEST_RUN_ALIAS) {
    const runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
    if (!runsRoot) {
      return null;
    }
    const latest = await readLatest(runsRoot);
    const expected = latest ? resolveLatestRunDirectory(cwd, latest) : null;
    if (!latest || !expected) {
      return null;
    }
    const runPaths = await bindExistingRunArtifactPaths(cwd, latest.runId);
    if (
      runPaths.absoluteRunRoot !== expected ||
      runPaths.physicalRunsRoot !== runsRoot.physicalPath
    ) {
      throw new Error("Latest run pointer changed physical runs root.");
    }
    await assertPreparedSelectedOutputDirectory(runsRoot);
    return runPaths;
  }

  if (!isSafeRunIdSegment(runInput) || !(await resolveExistingRunDirectory(cwd, runInput))) {
    return null;
  }
  return bindExistingRunArtifactPaths(cwd, runInput);
}

export async function readLatest(
  runsRoot: PreparedSelectedOutputDirectory,
): Promise<RunPointer | null> {
  const read = await readContainedRegularFile(runsRoot, "latest.json", LATEST_POINTER_MAX_BYTES);
  if (read.status === "missing") return null;
  if (read.status === "refused") {
    if (read.reason === "too-large")
      throw new ContainedReadRefusedError(path.join(RUNS_RELATIVE_ROOT, "latest.json"), read);
    throw new Error(
      read.reason === "not-regular"
        ? "Latest run pointer must be a single-link regular file."
        : "Latest run pointer changed while it was being read.",
    );
  }
  let latest: unknown;
  try {
    latest = JSON.parse(read.bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }

  return isRunPointer(latest) ? latest : null;
}

/** A run file as text: its text, nothing at the path, or why it was refused. */
export type RunTextRead =
  | { status: "read"; text: string }
  | { status: "missing" }
  | ContainedRefusal;

/** A run file as JSON. `value` is undefined when the file is there but is not valid JSON. */
export type RunJsonRead =
  | { status: "read"; value: unknown }
  | { status: "missing" }
  | ContainedRefusal;

/**
 * The JSON, or null for a file that is missing, refused or not valid JSON: for a caller that
 * treats the three alike, as every reader did before a refusal had its own state.
 */
export function runJsonValue(read: RunJsonRead): unknown {
  return read.status === "read" ? (read.value ?? null) : null;
}

/** A run file as JSON, within RUN_ARTIFACT_MAX_BYTES. */
export async function readRunJsonIfExists(
  runPaths: PreparedRunArtifactPaths,
  ...segments: string[]
): Promise<RunJsonRead> {
  const read = await readRunTextIfExists(runPaths, ...segments);
  if (read.status !== "read") return read;
  try {
    return { status: "read", value: JSON.parse(read.text) as unknown };
  } catch {
    return { status: "read", value: undefined };
  }
}

/** A run file as text, within RUN_ARTIFACT_MAX_BYTES. */
export async function readRunTextIfExists(
  runPaths: PreparedRunArtifactPaths,
  ...segments: string[]
): Promise<RunTextRead> {
  const read = await readContainedRegularFile(runPaths, segments.join("/"), RUN_ARTIFACT_MAX_BYTES);
  return read.status === "read" ? { status: "read", text: read.bytes.toString("utf8") } : read;
}

/**
 * A run file, read whole through the bounded evidence reader: `limit` when it holds more than
 * RUN_ARTIFACT_MAX_BYTES, `unavailable` when it is missing, unsafe, or changes while it is read.
 * A `\` in the path reads as `/`.
 */
export async function readSafeRunArtifact(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<BoundedFileResult> {
  return readBoundedFileResult(runPaths, relativePath.replace(/\\/g, "/"), RUN_ARTIFACT_MAX_BYTES);
}

/** readSafeRunArtifact's bytes, or null for any file it does not read. */
export async function readSafeRunArtifactBytes(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<Buffer | null> {
  const read = await readSafeRunArtifact(runPaths, relativePath);
  return read.state === "read" ? read.bytes : null;
}

export async function readSafeRunArtifactJson(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<unknown> {
  const bytes = await readSafeRunArtifactBytes(runPaths, relativePath);
  if (!bytes) {
    return null;
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function loadRunBundle(
  cwdInput: string,
  runInput: string,
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  const runPaths = await resolveRunPath(cwd, runInput).catch(() => null);

  if (!runPaths) {
    return null;
  }

  return loadRunBundlePrepared(cwd, runPaths);
}

/** loadRunBundle for a caller that already holds prepared paths. Revalidates them first. */
export async function loadRunBundlePrepared(
  cwdInput: string,
  runPaths: PreparedRunArtifactPaths,
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  await validatePreparedRunArtifactPaths(runPaths);
  const bundlePath = path.join(runPaths.absoluteRunRoot, RUN_BUNDLE_FILE);
  const read = await readRunJsonIfExists(runPaths, RUN_BUNDLE_FILE);
  // A run.json it refuses is no reason to call the run absent: the caller reports why.
  if (read.status === "refused") throw new ContainedReadRefusedError(RUN_BUNDLE_FILE, read);
  const bundle = read.status === "read" ? read.value : null;

  if (!isRunBundle(bundle)) {
    return null;
  }

  return {
    bundle,
    bundlePath: path.relative(cwd, bundlePath),
    runDir: runPaths.absoluteRunRoot,
  };
}
