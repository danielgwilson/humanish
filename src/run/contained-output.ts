import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  assertDirectoryIdentity,
  assertRegularFileOrMissing,
  isPathInside,
  prepareHumanishStorageDirectory,
  resolveExistingHumanishStorageDirectory,
  type PreparedRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  validatePreparedRunRootIdentity,
  type FileIdentity,
} from "./paths.js";
import { isNodeError } from "./type-guards.js";

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

/** A root for contained reads and writes: a prepared run directory or a prepared selected directory. */
export type PreparedOutputRoot = PreparedSelectedOutputDirectory | PreparedRunArtifactPaths;

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
  selectedPath: string,
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
  selectedPath: string,
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
  await assertRegularFileOrMissing(physicalPath, "Selected output files");
  const parentIdentity = await captureDirectoryIdentity(physicalParent);
  const prepared = Object.freeze({
    parentIdentity,
    physicalParent,
    physicalPath,
    requestedPath,
  });
  await assertPreparedSelectedOutputFile(prepared);
  return prepared;
}

export async function assertPreparedSelectedOutputDirectory(
  prepared: PreparedSelectedOutputDirectory,
): Promise<void> {
  if (prepared.parentRun) {
    await validatePreparedRunRootIdentity(prepared.parentRun);
  }
  const requestedPhysicalPath = await realpath(prepared.requestedPath);
  if (requestedPhysicalPath !== prepared.physicalPath) {
    throw new Error("Selected output root changed physical destination.");
  }
  await assertDirectoryIdentity(
    prepared.physicalPath,
    prepared.identity,
    "Selected output root identity changed after it was prepared.",
  );
}

async function assertPreparedSelectedOutputFile(
  prepared: PreparedSelectedOutputFile,
): Promise<void> {
  const requestedPhysicalParent = await realpath(path.dirname(prepared.requestedPath));
  if (requestedPhysicalParent !== prepared.physicalParent) {
    throw new Error("Selected output parent changed physical destination.");
  }
  await assertDirectoryIdentity(
    prepared.physicalParent,
    prepared.parentIdentity,
    "Selected output parent identity changed after it was prepared.",
  );
  await assertRegularFileOrMissing(prepared.physicalPath, "Selected output files");
}

export async function writePreparedSelectedOutputFile(
  prepared: PreparedSelectedOutputFile,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  await atomicWriteOutputFile(prepared.physicalParent, prepared.physicalPath, data, encoding, () =>
    assertPreparedSelectedOutputFile(prepared),
  );
}

/** Atomically write the sibling latest pointer bound by a prepared run token. */
export async function writePreparedRunLatestPointer(
  prepared: PreparedRunArtifactPaths,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  await atomicWriteOutputFile(
    prepared.physicalRunsRoot,
    prepared.physicalLatestPointer,
    data,
    encoding,
    async () => {
      await validatePreparedRunArtifactPaths(prepared);
    },
  );
}

export async function prepareContainedOutputDirectory(
  rootInput: PreparedOutputRoot,
  relativePath: string,
): Promise<string> {
  assertSafeRelativeOutputPath(relativePath, true);
  const root = await resolveOutputRoot(rootInput);
  return prepareDirectoryWithinRoot(root, normalizeRelativeOutputPath(relativePath));
}

/** Prepare and identity-bind a generated child directory under a prepared root. */
export async function prepareContainedOutputDirectoryRoot(
  rootInput: PreparedOutputRoot,
  relativePath: string,
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
  relativePath: string,
): Promise<string> {
  assertSafeRelativeOutputPath(relativePath, false);
  const root = await resolveOutputRoot(rootInput);
  const absolute = path.resolve(root, normalizeRelativeOutputPath(relativePath));
  if (!isPathInside(root, absolute) || absolute === root) {
    throw new Error("Output file must stay inside its selected root.");
  }
  const parent = await prepareDirectoryWithinRoot(
    root,
    path.relative(root, path.dirname(absolute)),
  );
  const filePath = path.join(parent, path.basename(absolute));
  await assertRegularFileOrMissing(filePath, "Selected output files");
  return filePath;
}

export async function writeContainedOutputFile(
  rootInput: PreparedOutputRoot,
  relativePath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const filePath = await prepareContainedOutputFile(rootInput, relativePath);
  const root = await resolveOutputRoot(rootInput);
  await atomicWriteOutputFile(path.dirname(filePath), filePath, data, encoding, async () => {
    const validatedRoot = await resolveOutputRoot(rootInput);
    if (validatedRoot !== root) {
      throw new Error("Output root changed after it was prepared.");
    }
    await assertContainedDirectoryChain(root, path.dirname(filePath));
    await assertRegularFileOrMissing(filePath, "Selected output files");
  });
}

/**
 * Creates a new file inside the root under its final name, refusing with EEXIST when that name
 * exists, so it never replaces a file. The file is opened with O_EXCL and O_NOFOLLOW, filled in one
 * write and synced, so a reader may briefly see it empty or short. It never has a temporary name or
 * a second link, so the run directory passes its single-link check at every moment.
 * writeContainedOutputFile renames a finished file into place instead, replacing what is there.
 */
export async function createContainedOutputFile(
  rootInput: PreparedOutputRoot,
  relativePath: string,
  data: string,
): Promise<void> {
  const filePath = await prepareContainedOutputFile(rootInput, relativePath);
  const root = await resolveOutputRoot(rootInput);
  await assertContainedDirectoryChain(root, path.dirname(filePath));
  const bytes = Buffer.from(data, "utf8");
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, 0);
    if (bytesWritten !== bytes.length) throw new Error("The file was not written in full.");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    // O_EXCL created this name here, so removing it removes only this file.
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

// The most humanish reads of one file of each kind. A larger file is refused unread.

/**
 * A file in a run directory or a preflight journal. verify reads every run file whole to scan it,
 * and a frame whole to check it, so this covers the largest screenshot src/evidence/image.ts
 * accepts (32 MiB). Every other reader of a run file uses the same limit, so no command reads a
 * run file that verify could not scan.
 */
export const RUN_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

/** `.humanish/runs/latest.json`: a run id and a path. */
export const LATEST_POINTER_MAX_BYTES = 64 * 1024;

/** A file a person writes in the project: study, persona and scenario YAML, package.json, agent instructions. */
export const PROJECT_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Why a contained read did not read a file that is there. `too-large`: it holds more than the
 * limit. `changed`: it, its folder or the root changed while it was opened or read, which
 * includes growing past the limit. `directory`: a folder is at the path. `not-regular`: a link, a
 * hard link or a special file. `unsafe-path`: the path leaves the root or passes through a link.
 * `unreadable`: the system refused the open or the read.
 */
export type ContainedRefusalReason =
  | "too-large"
  | "changed"
  | "directory"
  | "not-regular"
  | "unsafe-path"
  | "unreadable";

/** A file that is there and was not read: why, and the most the read would have taken. */
export interface ContainedRefusal {
  readonly status: "refused";
  readonly reason: ContainedRefusalReason;
  readonly limit: number;
}

/** What a contained read found: the bytes, nothing at the path, or a file it refused. */
export type ContainedRead =
  | { readonly status: "read"; readonly bytes: Buffer }
  | { readonly status: "missing" }
  | ContainedRefusal;

/** `relativePath` and why it was refused, as a clause: "x.yaml is larger than 4194304 bytes, ...". */
export function refusalText(relativePath: string, refusal: ContainedRefusal): string {
  switch (refusal.reason) {
    case "too-large":
      return `${relativePath} is larger than ${refusal.limit} bytes, the most humanish reads of it`;
    case "changed":
      return `${relativePath} changed while humanish read it`;
    case "directory":
      return `${relativePath} is a folder`;
    case "not-regular":
      return `${relativePath} is not a single-link regular file`;
    case "unsafe-path":
      return `${relativePath} leaves its folder or passes through a link`;
    case "unreadable":
      return `${relativePath} could not be read`;
  }
}

/** A refused contained read, for a caller that stops on one. The message names the file. */
export class ContainedReadRefusedError extends Error {
  constructor(
    readonly relativePath: string,
    readonly refusal: ContainedRefusal,
  ) {
    super(`${refusalText(relativePath, refusal)}.`);
    this.name = "ContainedReadRefusedError";
  }
}

/**
 * Read one regular file only when both lexical and physical paths stay in root and it holds at
 * most `maxBytes`. A larger file is refused without being read, and one that grows past
 * `maxBytes` while it is read is refused after at most `maxBytes + 1` bytes. `missing` means
 * nothing is at the path, or a folder on it is missing.
 */
export async function readContainedRegularFile(
  rootInput: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number,
): Promise<ContainedRead> {
  const opened = await openContained(rootInput, relativePath);
  if (opened.status === "missing") return opened;
  const refused = (reason: ContainedRefusalReason): ContainedRefusal => ({
    status: "refused",
    reason,
    limit: maxBytes,
  });
  if (opened.status === "refused") return refused(opened.reason);
  const { handle } = opened;
  try {
    if ((await handle.stat()).size > maxBytes) return refused("too-large");
    const bytes = await readOpenedAtMost(handle, maxBytes);
    return bytes === null ? refused("changed") : { status: "read", bytes };
  } catch {
    return refused("unreadable");
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * At most `maxBytes` from the start of an opened file, or null when it holds more. It reads by
 * position, in chunks of up to 64 KiB, and stops one byte past the limit, so a file that grew
 * after it was opened is never read whole.
 */
export async function readOpenedAtMost(
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

/** The caller owns this checked descriptor and must close it after reading/streaming. */
export async function openContainedRegularFile(
  rootInput: PreparedOutputRoot,
  relativePath: string,
): Promise<FileHandle | null> {
  const opened = await openContained(rootInput, relativePath);
  return opened.status === "open" ? opened.handle : null;
}

type ContainedOpen =
  | { status: "open"; handle: FileHandle }
  | { status: "missing" }
  | { status: "refused"; reason: ContainedRefusalReason };

/** The open behind both readers: every check, and what stopped it when one failed. */
async function openContained(
  rootInput: PreparedOutputRoot,
  relativePath: string,
): Promise<ContainedOpen> {
  const refused = (reason: ContainedRefusalReason) => ({ status: "refused", reason }) as const;
  const missingOr = (error: unknown, reason: ContainedRefusalReason): ContainedOpen =>
    isNodeError(error) && error.code === "ENOENT"
      ? { status: "missing" }
      : isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM")
        ? refused("unreadable")
        : refused(reason);
  try {
    assertSafeRelativeOutputPath(relativePath, false);
  } catch {
    return refused("unsafe-path");
  }
  let root: string;
  try {
    root = await resolveOutputRoot(rootInput);
  } catch {
    return refused("changed");
  }
  const candidate = path.resolve(root, normalizeRelativeOutputPath(relativePath));
  if (!isPathInside(root, candidate) || candidate === root) return refused("unsafe-path");
  let before: BigIntStats;
  try {
    await assertContainedDirectoryChain(root, path.dirname(candidate));
    before = await lstat(candidate, { bigint: true });
  } catch (error) {
    return missingOr(error, "unsafe-path");
  }
  if (before.isDirectory()) return refused("directory");
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1n)
    return refused("not-regular");
  let handle: FileHandle;
  try {
    if (!isPathInside(root, await realpath(candidate))) return refused("unsafe-path");
    // O_NONBLOCK: a file swapped for a FIFO after the lstat opens at once and fails the fstat
    // below, where a blocking open would wait for a writer.
    handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return missingOr(error, "changed");
  }
  try {
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.nlink > 1n ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (await resolveOutputRoot(rootInput)) !== root
    )
      throw new Error("Artifact identity changed.");
    await assertContainedDirectoryChain(root, path.dirname(candidate));
    return { status: "open", handle };
  } catch {
    await handle.close().catch(() => {});
    return refused("changed");
  }
}

export function assertSafeOutputPathSegment(value: string, label = "Output path segment"): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be one non-empty path segment.`);
  }
}

/** A non-empty relative path with no empty, `.` or `..` segment: the names a contained read accepts. */
export function isSafeRelativeFilePath(value: string): boolean {
  try {
    assertSafeRelativeOutputPath(value, false);
    return true;
  } catch {
    return false;
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
  const segments =
    relativePath === "" ? [] : relativePath.replace(/[\\/]+/g, path.sep).split(path.sep);
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
  parentRun?: PreparedRunArtifactPaths,
): Promise<PreparedSelectedOutputDirectory> {
  const prepared = Object.freeze({
    identity: await captureDirectoryIdentity(physicalPath),
    ...(parentRun === undefined ? {} : { parentRun }),
    physicalPath,
    requestedPath,
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
  const physicalParent = await resolveBaseDirectory(
    path.dirname(resolved),
    "Selected output parent",
  );
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

async function captureDirectoryIdentity(directory: string): Promise<FileIdentity> {
  const stats = await lstat(directory, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory() || (await realpath(directory)) !== directory) {
    throw new Error("Prepared output root must use a physical directory.");
  }
  return Object.freeze({ birthtimeNs: stats.birthtimeNs, dev: stats.dev, ino: stats.ino });
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
  revalidate: () => Promise<void>,
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
    await assertRegularFileOrMissing(target, "Selected output files");
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
