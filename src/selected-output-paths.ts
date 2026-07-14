import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  isPathInside,
  prepareHumanishStorageDirectory,
  resolveExistingHumanishStorageDirectory,
  type PreparedRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  validatePreparedRunRootIdentity
} from "./run-paths.js";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface PreparedSelectedOutputDirectory {
  readonly identity: FileIdentity;
  readonly parentRun?: PreparedRunArtifactPaths;
  readonly physicalPath: string;
  readonly requestedPath: string;
}

export interface PreparedSelectedOutputFile {
  readonly parentIdentity: FileIdentity;
  readonly physicalParent: string;
  readonly physicalPath: string;
  readonly requestedPath: string;
}

export type PreparedOutputDirectory = PreparedSelectedOutputDirectory | PreparedRunArtifactPaths;
export type PreparedOutputRoot = PreparedOutputDirectory;

/**
 * Prepare an arbitrary caller-selected output directory without changing the
 * caller's resolution contract. Relative values resolve against baseDir;
 * absolute values keep their authority. Every spelling is caller authority:
 * existing aliases in the selected directory or its parents are canonicalized
 * once, then bound by physical path and directory identity. Managed defaults
 * must use a strict storage preparer instead.
 */
export async function prepareSelectedOutputDirectory(
  baseDir: string,
  selectedPath: string
): Promise<PreparedSelectedOutputDirectory> {
  assertPathText(selectedPath, "Output directory");
  const requestedPath = path.resolve(baseDir, selectedPath);
  const physicalPath = await prepareAbsoluteSelectedDirectory(requestedPath);
  return captureSelectedOutputDirectory(requestedPath, physicalPath);
}

/** Prepare a strict `.humanish`-managed directory, then bind its identity. */
export async function prepareManagedHumanishOutputDirectory(
  cwd: string,
  ...segments: string[]
): Promise<PreparedSelectedOutputDirectory> {
  const requestedPath = path.resolve(cwd, ".humanish", ...segments);
  const preparedPath = await prepareHumanishStorageDirectory(cwd, ...segments);
  const physicalPath = await realpath(preparedPath);
  return captureSelectedOutputDirectory(requestedPath, physicalPath);
}

/** Bind an existing strict `.humanish` directory without creating storage. */
export async function bindExistingManagedHumanishOutputDirectory(
  cwd: string,
  ...segments: string[]
): Promise<PreparedSelectedOutputDirectory | null> {
  const requestedPath = path.resolve(cwd, ".humanish", ...segments);
  const existing = await resolveExistingHumanishStorageDirectory(cwd, ...segments);
  if (!existing || existing !== requestedPath) {
    return null;
  }
  return captureSelectedOutputDirectory(requestedPath, await realpath(existing));
}

/** Prepare an arbitrary caller-selected output file whose parent is independent. */
export async function prepareSelectedOutputFile(
  baseDir: string,
  selectedPath: string
): Promise<PreparedSelectedOutputFile> {
  assertPathText(selectedPath, "Output file");
  const requestedPath = path.resolve(baseDir, selectedPath);
  const fileName = path.basename(requestedPath);
  if (!fileName || requestedPath === path.parse(requestedPath).root) {
    throw new Error("Output file must name a regular file.");
  }

  const requestedParent = path.dirname(requestedPath);
  const physicalParent = await prepareAbsoluteSelectedDirectory(requestedParent);
  const physicalPath = path.join(physicalParent, fileName);
  await assertRegularFileOrMissing(physicalPath);
  const parentIdentity = await captureDirectoryIdentity(physicalParent);
  const prepared = Object.freeze({
    parentIdentity,
    physicalParent,
    physicalPath,
    requestedPath
  });
  await assertPreparedSelectedOutputFile(prepared);
  return prepared;
}

export async function assertPreparedSelectedOutputDirectory(
  prepared: PreparedSelectedOutputDirectory
): Promise<void> {
  if (prepared.parentRun) {
    await validatePreparedRunRootIdentity(prepared.parentRun);
  }
  const requestedPhysicalPath = await realpath(prepared.requestedPath);
  if (requestedPhysicalPath !== prepared.physicalPath) {
    throw new Error("Selected output root changed physical destination.");
  }
  await assertDirectoryIdentity(prepared.physicalPath, prepared.identity, "Selected output root");
}

export async function assertPreparedSelectedOutputFile(
  prepared: PreparedSelectedOutputFile
): Promise<void> {
  const requestedPhysicalParent = await realpath(path.dirname(prepared.requestedPath));
  if (requestedPhysicalParent !== prepared.physicalParent) {
    throw new Error("Selected output parent changed physical destination.");
  }
  await assertDirectoryIdentity(prepared.physicalParent, prepared.parentIdentity, "Selected output parent");
  await assertRegularFileOrMissing(prepared.physicalPath);
}

export async function writePreparedSelectedOutputFile(
  prepared: PreparedSelectedOutputFile,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void> {
  await atomicWriteOutputFile(
    prepared.physicalParent,
    prepared.physicalPath,
    data,
    encoding,
    () => assertPreparedSelectedOutputFile(prepared)
  );
}

/** Atomically write the sibling latest pointer bound by a prepared run token. */
export async function writePreparedRunLatestPointer(
  prepared: PreparedRunArtifactPaths,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void> {
  await atomicWriteOutputFile(
    prepared.physicalRunsRoot,
    prepared.physicalLatestPointer,
    data,
    encoding,
    async () => {
      await validatePreparedRunArtifactPaths(prepared);
    }
  );
}

export async function prepareContainedOutputDirectory(
  rootInput: PreparedOutputRoot,
  relativePath: string
): Promise<string> {
  assertSafeRelativeOutputPath(relativePath, true);
  const root = await resolveOutputRoot(rootInput);
  return prepareDirectoryWithinRoot(root, normalizeRelativeOutputPath(relativePath));
}

/** Prepare and identity-bind a generated child directory under a prepared root. */
export async function prepareContainedOutputDirectoryRoot(
  rootInput: PreparedOutputDirectory,
  relativePath: string
): Promise<PreparedSelectedOutputDirectory> {
  const root = await resolveOutputRoot(rootInput);
  const physicalPath = await prepareContainedOutputDirectory(rootInput, relativePath);
  const revalidatedRoot = await resolveOutputRoot(rootInput);
  if (revalidatedRoot !== root) {
    throw new Error("Output root changed after it was prepared.");
  }
  const parentRun = "physicalRunRoot" in rootInput ? rootInput : rootInput.parentRun;
  return captureSelectedOutputDirectory(physicalPath, physicalPath, parentRun);
}

export async function prepareContainedOutputFile(
  rootInput: PreparedOutputRoot,
  relativePath: string
): Promise<string> {
  assertSafeRelativeOutputPath(relativePath, false);
  const root = await resolveOutputRoot(rootInput);
  const absolute = path.resolve(root, normalizeRelativeOutputPath(relativePath));
  if (!isPathInside(root, absolute) || absolute === root) {
    throw new Error("Output file must stay inside its selected root.");
  }
  const parent = await prepareDirectoryWithinRoot(root, path.relative(root, path.dirname(absolute)));
  const filePath = path.join(parent, path.basename(absolute));
  await assertRegularFileOrMissing(filePath);
  return filePath;
}

export async function writeContainedOutputFile(
  rootInput: PreparedOutputRoot,
  relativePath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void> {
  const filePath = await prepareContainedOutputFile(rootInput, relativePath);
  const root = await resolveOutputRoot(rootInput);
  await atomicWriteOutputFile(
    path.dirname(filePath),
    filePath,
    data,
    encoding,
    async () => {
      const validatedRoot = await resolveOutputRoot(rootInput);
      if (validatedRoot !== root) {
        throw new Error("Output root changed after it was prepared.");
      }
      await assertContainedDirectoryChain(root, path.dirname(filePath));
      await assertRegularFileOrMissing(filePath);
    }
  );
}

/** Read one regular file only when both lexical and physical paths stay in root. */
export async function readContainedRegularFile(
  rootInput: PreparedOutputRoot,
  relativePath: string
): Promise<Buffer | null> {
  try {
    assertSafeRelativeOutputPath(relativePath, false);
    const root = await resolveOutputRoot(rootInput);
    const candidate = path.resolve(root, normalizeRelativeOutputPath(relativePath));
    if (!isPathInside(root, candidate) || candidate === root) {
      return null;
    }
    await assertContainedDirectoryChain(root, path.dirname(candidate));
    const before = await lstat(candidate, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1n) {
      return null;
    }
    const physicalFile = await realpath(candidate);
    if (!isPathInside(root, physicalFile)) {
      return null;
    }
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat({ bigint: true });
      if (
        !after.isFile()
        || after.nlink > 1n
        || after.dev !== before.dev
        || after.ino !== before.ino
      ) {
        return null;
      }
      const revalidatedRoot = await resolveOutputRoot(rootInput);
      if (revalidatedRoot !== root) {
        return null;
      }
      await assertContainedDirectoryChain(root, path.dirname(candidate));
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function assertSafeOutputPathSegment(value: string, label = "Output path segment"): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be one non-empty path segment.`);
  }
}

function assertSafeRelativeOutputPath(value: string, allowEmpty: boolean): void {
  if ((!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new Error("Output path must be a non-empty relative path.");
  }
  if (value === "" && allowEmpty) {
    return;
  }
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("Output path must be relative to its selected root.");
  }
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Output path must not contain empty or traversal segments.");
  }
}

function normalizeRelativeOutputPath(value: string): string {
  return value.replace(/[\\/]+/g, path.sep);
}

async function prepareDirectoryWithinRoot(root: string, relativePath: string): Promise<string> {
  const segments = relativePath === ""
    ? []
    : relativePath.replace(/[\\/]+/g, path.sep).split(path.sep);
  let current = root;
  for (const segment of segments) {
    assertSafeOutputPathSegment(segment);
    current = path.join(current, segment);
    await mkdirDirectoryLeaf(current);
  }
  const physical = await realpath(current);
  if (!isPathInside(root, physical)) {
    throw new Error("Output directory resolved outside its selected root.");
  }
  return physical;
}

async function captureSelectedOutputDirectory(
  requestedPath: string,
  physicalPath: string,
  parentRun?: PreparedRunArtifactPaths
): Promise<PreparedSelectedOutputDirectory> {
  const prepared = Object.freeze({
    identity: await captureDirectoryIdentity(physicalPath),
    ...(parentRun === undefined ? {} : { parentRun }),
    physicalPath,
    requestedPath
  });
  await assertPreparedSelectedOutputDirectory(prepared);
  return prepared;
}

async function prepareAbsoluteSelectedDirectory(absolutePath: string): Promise<string> {
  const resolved = path.resolve(absolutePath);
  try {
    const existing = await lstat(resolved);
    if (!existing.isDirectory() && !existing.isSymbolicLink()) {
      throw new Error("Selected output root must resolve to a directory.");
    }
    const physical = await realpath(resolved);
    const physicalStats = await lstat(physical);
    if (!physicalStats.isDirectory()) {
      throw new Error("Selected output root must resolve to a directory.");
    }
    return physical;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const physicalParent = await resolveBaseDirectory(path.dirname(resolved), "Selected output parent");
  const selectedLeaf = path.join(physicalParent, path.basename(resolved));
  await mkdirDirectoryLeaf(selectedLeaf);
  return realpath(selectedLeaf);
}

async function mkdirDirectoryLeaf(directory: string): Promise<void> {
  try {
    await mkdir(directory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const stats = await lstat(directory, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Selected output directories must not be symbolic links or non-directories.");
  }
}

async function resolveOutputRoot(root: PreparedOutputRoot): Promise<string> {
  if ("physicalRunRoot" in root) {
    await validatePreparedRunRootIdentity(root);
    return root.physicalRunRoot;
  }
  await assertPreparedSelectedOutputDirectory(root);
  return root.physicalPath;
}

async function resolveBaseDirectory(directory: string, label: string): Promise<string> {
  const physical = await realpath(path.resolve(directory));
  const stats = await lstat(physical);
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
  return physical;
}

async function assertRegularFileOrMissing(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
      throw new Error("Selected output files must be single-link regular files, not symbolic links or hardlinks.");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function captureDirectoryIdentity(directory: string): Promise<FileIdentity> {
  const stats = await lstat(directory, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory() || await realpath(directory) !== directory) {
    throw new Error("Prepared output root must use a physical directory.");
  }
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

async function assertDirectoryIdentity(
  directory: string,
  identity: FileIdentity,
  label: string
): Promise<void> {
  const stats = await lstat(directory, { bigint: true });
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || await realpath(directory) !== directory
  ) {
    throw new Error(`${label} identity changed after it was prepared.`);
  }
}

async function assertContainedDirectoryChain(root: string, directory: string): Promise<void> {
  if (!isPathInside(root, directory)) {
    throw new Error("Output directory must stay inside its selected root.");
  }
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Selected output directories must not be symbolic links or non-directories.");
    }
  }
}

async function atomicWriteOutputFile(
  parent: string,
  target: string,
  data: string | Uint8Array,
  encoding: BufferEncoding | undefined,
  revalidate: () => Promise<void>
): Promise<void> {
  await revalidate();
  const temporary = path.join(parent, `.humanish-write-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    if (typeof data === "string") {
      await handle.writeFile(data, encoding ?? "utf8");
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await revalidate();
    await rename(temporary, target);
    await assertRegularFileOrMissing(target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function assertPathText(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain a null byte.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
