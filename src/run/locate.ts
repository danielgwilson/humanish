import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  resolveExistingRunDirectory,
  resolveLatestRunDirectory,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  bindExistingManagedHumanishOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "./selected-output-paths.js";
import type { RunPointer, RunResult } from "./results.js";
import { isRunPointer } from "./guards.js";
import { isNodeError, isRecord } from "./primitives.js";

async function inspectImplicitProjectPath(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
) {
  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error("Implicit project path must be a non-empty relative path.");
  }
  await assertPreparedSelectedOutputDirectory(projectRoot);
  let current = projectRoot.physicalPath;
  for (const [index, segment] of segments.entries()) {
    assertSafeOutputPathSegment(segment, "Implicit project path segment");
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Implicit project path must not contain symbolic links: ${relativePath}`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(
        `Implicit project path must contain only regular files and directories: ${relativePath}`,
      );
    }
    if (stats.isFile() && stats.nlink > 1n) {
      throw new Error(`Implicit project files must be single-link regular files: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Implicit project path parent must be a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      await assertPreparedSelectedOutputDirectory(projectRoot);
      return stats;
    }
  }
  return null;
}

export async function implicitProjectDirectoryExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<boolean> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return false;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Implicit project directory has the wrong type: ${relativePath}`);
  }
  return true;
}

export async function readImplicitProjectFile(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<string | null> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return null;
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`Implicit project file must be a single-link regular file: ${relativePath}`);
  }
  const bytes = await readContainedRegularFile(projectRoot, relativePath.replace(/\\/g, "/"));
  if (!bytes) {
    throw new Error(`Implicit project file changed while it was being read: ${relativePath}`);
  }
  return bytes.toString("utf8");
}

/** Resolve "latest" or an explicit run id to its prepared artifact paths. */
export async function resolveRunPath(
  cwd: string,
  runInput: string,
): Promise<PreparedRunArtifactPaths | null> {
  if (runInput === "latest") {
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

export async function readPackageName(
  projectRoot: PreparedSelectedOutputDirectory,
): Promise<string | null> {
  const text = await readImplicitProjectFile(projectRoot, "package.json");
  if (text === null) {
    return null;
  }
  try {
    const packageJson = JSON.parse(text) as unknown;
    return isRecord(packageJson) && typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
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

export async function validateCwd(cwd: string): Promise<RunResult["error"] | null> {
  try {
    const stats = await stat(cwd);

    if (!stats.isDirectory()) {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`,
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd does not exist: ${cwd}`,
      };
    }

    throw error;
  }
}
