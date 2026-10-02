import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  resolveExistingRunDirectory,
  resolveLatestRunDirectory,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "./contained-output.js";
import type { RunPointer } from "./results.js";
import { RUN_BUNDLE_FILE, type RunBundle } from "./bundle.js";
import { isRunBundle, isRunPointer } from "./bundle-shape.js";
import { isNodeError } from "./type-guards.js";

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
  const latestPath = path.join(runsRoot.physicalPath, "latest.json");
  let latestStats;
  try {
    latestStats = await lstat(latestPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (latestStats.isSymbolicLink() || !latestStats.isFile() || latestStats.nlink !== 1n) {
    throw new Error("Latest run pointer must be a single-link regular file.");
  }
  const bytes = await readContainedRegularFile(runsRoot, "latest.json");
  if (!bytes) {
    throw new Error("Latest run pointer changed while it was being read.");
  }
  let latest: unknown;
  try {
    latest = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }

  return isRunPointer(latest) ? latest : null;
}

export async function readRunJsonIfExists(
  runPaths: PreparedRunArtifactPaths,
  ...segments: string[]
): Promise<unknown> {
  const text = await readRunTextIfExists(runPaths, ...segments);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function readRunTextIfExists(
  runPaths: PreparedRunArtifactPaths,
  ...segments: string[]
): Promise<string | null> {
  const bytes = await readContainedRegularFile(runPaths, segments.join("/"));
  return bytes?.toString("utf8") ?? null;
}

export async function readSafeRunArtifactBytes(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<Buffer | null> {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return readContainedRegularFile(runPaths, normalized);
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
  const bundle = await readRunJsonIfExists(runPaths, RUN_BUNDLE_FILE);

  if (!isRunBundle(bundle)) {
    return null;
  }

  return {
    bundle,
    bundlePath: path.relative(cwd, bundlePath),
    runDir: runPaths.absoluteRunRoot,
  };
}
