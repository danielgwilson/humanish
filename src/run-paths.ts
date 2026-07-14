import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const RUNS_RELATIVE_ROOT = path.join(".humanish", "runs");
export const LATEST_RUN_RELATIVE_PATH = path.join(RUNS_RELATIVE_ROOT, "latest.json");

export interface RunArtifactPaths {
  absoluteRunRoot: string;
  relativeRunRoot: string;
  absoluteLatestPointer: string;
  relativeLatestPointer: string;
}

export interface PreparedRunArtifactPaths extends RunArtifactPaths {
  readonly physicalLatestPointer: string;
  readonly physicalRunRoot: string;
  readonly physicalRunsRoot: string;
  readonly runRootIdentity: FileIdentity;
  readonly runsRootIdentity: FileIdentity;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface LatestRunPathPointer {
  runId: string;
  path: string;
}

/**
 * Run ids are directory names, not paths. Keep the accepted grammar broad so
 * existing runs remain readable while rejecting every path-shaped input.
 */
export function isSafeRunIdSegment(runId: string): boolean {
  return runId.length > 0
    && runId !== "."
    && runId !== ".."
    && !runId.includes("/")
    && !runId.includes("\\")
    && !runId.includes("\0");
}

export function resolveRunsRoot(cwdInput: string): string {
  return path.resolve(cwdInput, RUNS_RELATIVE_ROOT);
}

export function resolveRunDirectory(cwdInput: string, runId: string): string {
  if (!isSafeRunIdSegment(runId)) {
    throw new Error("Run id must be one non-empty path segment.");
  }

  const runsRoot = resolveRunsRoot(cwdInput);
  const runRoot = path.resolve(runsRoot, runId);
  if (!isPathInside(runsRoot, runRoot) || path.dirname(runRoot) !== runsRoot) {
    throw new Error("Run directory must stay inside the Humanish runs root.");
  }

  return runRoot;
}

export function tryResolveRunDirectory(cwdInput: string, runId: string): string | null {
  try {
    return resolveRunDirectory(cwdInput, runId);
  } catch {
    return null;
  }
}

export function resolveRunArtifactPaths(cwdInput: string, runId: string): RunArtifactPaths {
  if (runId === "latest.json") {
    throw new Error("Run id is reserved; choose a different run id.");
  }
  const absoluteRunRoot = resolveRunDirectory(cwdInput, runId);
  return {
    absoluteRunRoot,
    relativeRunRoot: path.join(RUNS_RELATIVE_ROOT, runId),
    absoluteLatestPointer: path.resolve(cwdInput, LATEST_RUN_RELATIVE_PATH),
    relativeLatestPointer: LATEST_RUN_RELATIVE_PATH
  };
}

export async function prepareRunArtifactPaths(cwdInput: string, runId: string): Promise<PreparedRunArtifactPaths> {
  const paths = resolveRunArtifactPaths(cwdInput, runId);
  const prepared = await prepareHumanishStorageDirectory(cwdInput, "runs", runId);
  if (prepared !== paths.absoluteRunRoot) {
    throw new Error("Run directory resolved outside the expected storage root.");
  }
  await assertNoSymlinkDescendants(prepared);
  await assertRegularFileOrMissing(paths.absoluteLatestPointer);
  return validatePreparedRunArtifactPaths(await capturePreparedRunArtifactPaths(paths, prepared));
}

export async function validatePreparedRunArtifactPaths(
  prepared: PreparedRunArtifactPaths
): Promise<PreparedRunArtifactPaths> {
  await validatePreparedRunRootIdentity(prepared);
  await assertNoSymlinkDescendants(prepared.physicalRunRoot);
  await assertRegularFileOrMissing(prepared.physicalLatestPointer);
  return prepared;
}

/** Cheap revalidation for repeated contained reads/writes within one prepared run. */
export async function validatePreparedRunRootIdentity(
  prepared: PreparedRunArtifactPaths
): Promise<PreparedRunArtifactPaths> {
  const [lexicalRunsRoot, lexicalRunRoot] = await Promise.all([
    realpath(path.dirname(prepared.absoluteRunRoot)),
    realpath(prepared.absoluteRunRoot)
  ]);
  if (lexicalRunsRoot !== prepared.physicalRunsRoot || lexicalRunRoot !== prepared.physicalRunRoot) {
    throw new Error("Prepared Humanish run storage changed physical destination.");
  }
  await Promise.all([
    assertDirectoryIdentity(prepared.physicalRunsRoot, prepared.runsRootIdentity),
    assertDirectoryIdentity(prepared.physicalRunRoot, prepared.runRootIdentity)
  ]);
  return prepared;
}

/** Bind an already-existing safe run as a new identity; this is not prior-preparation proof. */
export async function bindExistingRunArtifactPaths(
  cwdInput: string,
  runId: string
): Promise<PreparedRunArtifactPaths> {
  const paths = resolveRunArtifactPaths(cwdInput, runId);
  const existing = await resolveExistingRunDirectory(cwdInput, runId);
  if (!existing || existing !== paths.absoluteRunRoot) {
    throw new Error("Run directory is not an existing Humanish run directory.");
  }
  await assertNoSymlinkDescendants(existing);
  await assertRegularFileOrMissing(paths.absoluteLatestPointer);
  return validatePreparedRunArtifactPaths(await capturePreparedRunArtifactPaths(paths, existing));
}

export async function resolveExistingRunDirectory(cwdInput: string, runId: string): Promise<string | null> {
  const expected = tryResolveRunDirectory(cwdInput, runId);
  if (!expected) {
    return null;
  }

  const existing = await resolveExistingHumanishStorageDirectory(cwdInput, "runs", runId);
  return existing === expected ? existing : null;
}

/**
 * A latest pointer is valid only when both fields identify the same direct
 * child of .humanish/runs. Callers must never use pointer.path directly.
 */
export function resolveLatestRunDirectory(
  cwdInput: string,
  pointer: LatestRunPathPointer
): string | null {
  const expected = tryResolveRunDirectory(cwdInput, pointer.runId);
  if (!expected || !isProjectRelativePath(pointer.path)) {
    return null;
  }

  const declared = path.resolve(cwdInput, pointer.path);
  return declared === expected ? expected : null;
}

export async function resolveExistingLatestRunDirectory(
  cwdInput: string,
  pointer: LatestRunPathPointer
): Promise<string | null> {
  const expected = resolveLatestRunDirectory(cwdInput, pointer);
  if (!expected) {
    return null;
  }

  const existing = await resolveExistingRunDirectory(cwdInput, pointer.runId);
  return existing === expected ? existing : null;
}

export async function isRegularHumanishStorageFile(
  cwdInput: string,
  ...segments: string[]
): Promise<boolean> {
  const parent = await resolveExistingHumanishStorageDirectory(cwdInput, ...segments.slice(0, -1));
  const fileName = segments.at(-1);
  if (!parent || !fileName || !isSafeStorageSegment(fileName)) {
    return false;
  }

  try {
    const stats = await lstat(path.join(parent, fileName));
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function prepareHumanishStorageDirectory(
  cwdInput: string,
  ...segments: string[]
): Promise<string> {
  const prepared = await walkHumanishStorage(cwdInput, segments, true);
  if (!prepared) {
    throw new Error("Humanish storage directory could not be created.");
  }
  return prepared;
}

export async function prepareReusableHumanishStorageDirectory(
  cwdInput: string,
  ...segments: string[]
): Promise<string> {
  const prepared = await prepareHumanishStorageDirectory(cwdInput, ...segments);
  await assertNoSymlinkDescendants(prepared);
  return prepared;
}

export async function prepareExclusiveHumanishStorageDirectories(
  cwdInput: string,
  segmentSets: string[][]
): Promise<string[]> {
  const targets: string[] = [];
  for (const segments of segmentSets) {
    assertSafeStorageSegments(segments);
    const name = segments.at(-1);
    if (!name) {
      throw new Error("Exclusive Humanish storage directory needs a leaf segment.");
    }
    const parent = await prepareHumanishStorageDirectory(cwdInput, ...segments.slice(0, -1));
    const target = path.join(parent, name);
    try {
      await lstat(target);
      throw new Error("Humanish storage id already exists; choose a new id.");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    targets.push(target);
  }

  for (const target of targets) {
    try {
      await mkdir(target);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error("Humanish storage id already exists; choose a new id.");
      }
      throw error;
    }
  }
  return targets;
}

export async function prepareExclusiveHumanishStorageDirectory(
  cwdInput: string,
  ...segments: string[]
): Promise<string> {
  const [target] = await prepareExclusiveHumanishStorageDirectories(cwdInput, [segments]);
  if (!target) {
    throw new Error("Exclusive Humanish storage directory was not created.");
  }
  return target;
}

export async function prepareHumanishStorageFile(
  cwdInput: string,
  ...segments: string[]
): Promise<string> {
  const fileName = segments.at(-1);
  if (!fileName || !isSafeStorageSegment(fileName)) {
    throw new Error("Humanish storage file must use a non-empty path segment.");
  }
  const parent = await prepareHumanishStorageDirectory(cwdInput, ...segments.slice(0, -1));
  const filePath = path.join(parent, fileName);
  await assertRegularFileOrMissing(filePath);
  return filePath;
}

export function resolveHumanishStorageDirectory(cwdInput: string, ...segments: string[]): string {
  assertSafeStorageSegments(segments);
  const humanishRoot = path.resolve(cwdInput, ".humanish");
  const resolved = path.resolve(humanishRoot, ...segments);
  if (!isPathInside(humanishRoot, resolved)) {
    throw new Error("Humanish storage directory must stay inside .humanish.");
  }
  return resolved;
}

export async function resolveExistingHumanishStorageDirectory(
  cwdInput: string,
  ...segments: string[]
): Promise<string | null> {
  return walkHumanishStorage(cwdInput, segments, false);
}

export function isPathInside(rootInput: string, candidateInput: string): boolean {
  const root = path.resolve(rootInput);
  const candidate = path.resolve(candidateInput);
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isProjectRelativePath(value: string): boolean {
  const parts = value.replace(/\\/g, "/").split("/");
  return value.length > 0
    && !path.isAbsolute(value)
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !value.includes("\0")
    && !parts.some((part) => part === "." || part === "..");
}

async function walkHumanishStorage(
  cwdInput: string,
  segments: string[],
  create: boolean
): Promise<string | null> {
  assertSafeStorageSegments(segments);
  let current = path.resolve(cwdInput);

  for (const segment of [".humanish", ...segments]) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      if (!create) {
        return null;
      }
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      stats = await lstat(current);
    }

    if (stats.isSymbolicLink()) {
      throw new Error("Humanish storage directories must not be symbolic links.");
    }
    if (!stats.isDirectory()) {
      throw new Error("ENOTDIR: Humanish storage path must be a directory.");
    }
  }

  return current;
}

function assertSafeStorageSegments(segments: string[]): void {
  if (!segments.every(isSafeStorageSegment)) {
    throw new Error("Humanish storage paths must use non-empty path segments.");
  }
}

function isSafeStorageSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.includes("/")
    && !segment.includes("\\")
    && !segment.includes("\0");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function assertRegularFileOrMissing(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
      throw new Error("Humanish storage files must be single-link regular files, not symbolic links or hardlinks.");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertNoSymlinkDescendants(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const stats = await lstat(child);
    if (stats.isSymbolicLink()) {
      throw new Error("Humanish run directories must not contain symbolic links.");
    }
    if (stats.isDirectory()) {
      await assertNoSymlinkDescendants(child);
    } else if (!stats.isFile() || stats.nlink > 1) {
      throw new Error("Humanish run leaves must be single-link regular files, not hardlinks or special files.");
    }
  }
}

async function capturePreparedRunArtifactPaths(
  paths: RunArtifactPaths,
  runRoot: string
): Promise<PreparedRunArtifactPaths> {
  const physicalRunRoot = await realpath(runRoot);
  const physicalRunsRoot = await realpath(path.dirname(runRoot));
  const [runStats, runsStats] = await Promise.all([
    lstat(physicalRunRoot, { bigint: true }),
    lstat(physicalRunsRoot, { bigint: true })
  ]);
  if (!runStats.isDirectory() || runStats.isSymbolicLink() || !runsStats.isDirectory() || runsStats.isSymbolicLink()) {
    throw new Error("Prepared Humanish run storage must use physical directories.");
  }
  return Object.freeze({
    ...paths,
    physicalLatestPointer: path.join(physicalRunsRoot, "latest.json"),
    physicalRunRoot,
    physicalRunsRoot,
    runRootIdentity: Object.freeze({ dev: runStats.dev, ino: runStats.ino }),
    runsRootIdentity: Object.freeze({ dev: runsStats.dev, ino: runsStats.ino })
  });
}

async function assertDirectoryIdentity(directory: string, identity: FileIdentity): Promise<void> {
  const stats = await lstat(directory, { bigint: true });
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || await realpath(directory) !== directory
  ) {
    throw new Error("Prepared Humanish run storage identity changed.");
  }
}
