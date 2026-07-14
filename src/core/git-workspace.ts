import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const GIT_METADATA_INSPECTION_FAILED_NOTE = "Git metadata could not be inspected safely.";
export const GIT_METADATA_CONTAINMENT_FAILED_NOTE = "Git metadata failed containment validation.";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface VerifiedGitWorkspace {
  readonly commonDir: string;
  readonly configOverrides: readonly string[];
  readonly gitDir: string;
  readonly kind: "directory" | "linked-worktree";
  readonly trustRoot: string;
  readonly worktreeRoot: string;
}

export type GitWorkspaceInspection =
  | { readonly status: "missing" }
  | {
      readonly note: typeof GIT_METADATA_INSPECTION_FAILED_NOTE | typeof GIT_METADATA_CONTAINMENT_FAILED_NOTE;
      readonly status: "unsafe";
      readonly worktreeRoot: string;
    }
  | { readonly status: "verified"; readonly workspace: VerifiedGitWorkspace };

/**
 * Resolve one physical Git worktree without trusting ambient Git discovery.
 *
 * A regular `.git` file is accepted only for Git's exact linked-worktree
 * topology: `<common>/.git/worktrees/<name>` plus single-link `commondir` and
 * `gitdir` backpointer files. Arbitrary `gitdir:` redirects (including valid
 * separate-git-dir repositories) are deliberately unavailable because they
 * delegate metadata authority outside the selected project without a
 * verifiable backlink.
 */
export async function inspectVerifiedGitWorkspace(cwdInput: string): Promise<GitWorkspaceInspection> {
  let current: string;
  try {
    current = await realpath(path.resolve(cwdInput));
    const cwdStats = await lstat(current);
    if (cwdStats.isSymbolicLink() || !cwdStats.isDirectory()) {
      return unsafeInspection(current, GIT_METADATA_INSPECTION_FAILED_NOTE);
    }
  } catch {
    return unsafeInspection(path.resolve(cwdInput), GIT_METADATA_INSPECTION_FAILED_NOTE);
  }

  while (true) {
    const dotGitPath = path.join(current, ".git");
    let dotGitStats;
    try {
      dotGitStats = await lstat(dotGitPath, { bigint: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return unsafeInspection(current, GIT_METADATA_INSPECTION_FAILED_NOTE);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { status: "missing" };
      }
      current = parent;
      continue;
    }

    if (dotGitStats.isSymbolicLink()) {
      return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
    }

    if (dotGitStats.isDirectory()) {
      try {
        if (await realpath(dotGitPath) !== dotGitPath) {
          return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
        }
        // A normal worktree does not need commondir. Accepting one here would
        // let a contained `.git/` silently redirect config, refs, and objects.
        if (await pathExists(path.join(dotGitPath, "commondir"))) {
          return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
        }
        const configOverrides: string[] = [];
        const workspace: VerifiedGitWorkspace = {
          commonDir: dotGitPath,
          configOverrides,
          gitDir: dotGitPath,
          kind: "directory",
          trustRoot: current,
          worktreeRoot: current
        };
        return await validateCriticalGitMetadata(workspace)
          ? { status: "verified", workspace: freezeVerifiedWorkspace(workspace, configOverrides) }
          : unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      } catch {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }
    }

    if (!dotGitStats.isFile() || dotGitStats.nlink !== 1n) {
      return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
    }

    try {
      const dotGit = await readSingleLinkRegularFile(dotGitPath);
      const declaredGitDir = dotGit ? parseGitdirFile(dotGit.text) : null;
      if (!dotGit || !declaredGitDir) {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }

      const gitDir = await realpath(
        path.isAbsolute(declaredGitDir)
          ? declaredGitDir
          : path.resolve(current, declaredGitDir)
      );
      if (!await isPhysicalDirectory(gitDir)) {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }

      const commondir = await readSingleLinkRegularFile(path.join(gitDir, "commondir"));
      const backpointer = await readSingleLinkRegularFile(path.join(gitDir, "gitdir"));
      const declaredCommonDir = commondir ? parseSinglePathLine(commondir.text) : null;
      const declaredBackpointer = backpointer ? parseSinglePathLine(backpointer.text) : null;
      if (!commondir || !backpointer || !declaredCommonDir || !declaredBackpointer) {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }

      const commonDir = await realpath(path.resolve(gitDir, declaredCommonDir));
      if (
        !await isPhysicalDirectory(commonDir)
        || path.basename(commonDir) !== ".git"
        || path.dirname(gitDir) !== path.join(commonDir, "worktrees")
        || path.basename(gitDir).length === 0
      ) {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }

      const physicalBackpointer = await realpath(
        path.isAbsolute(declaredBackpointer)
          ? declaredBackpointer
          : path.resolve(gitDir, declaredBackpointer)
      );
      if (physicalBackpointer !== dotGitPath) {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }

      const trustRoot = path.dirname(commonDir);
      if (
        !await isPhysicalDirectory(trustRoot)
        || await realpath(path.join(trustRoot, ".git")) !== commonDir
        || !await stillSameSingleLinkFile(dotGitPath, dotGit.identity)
        || !await stillSameSingleLinkFile(path.join(gitDir, "commondir"), commondir.identity)
        || !await stillSameSingleLinkFile(path.join(gitDir, "gitdir"), backpointer.identity)
      ) {
        return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
      }

      const configOverrides: string[] = [];
      const workspace: VerifiedGitWorkspace = {
        commonDir,
        configOverrides,
        gitDir,
        kind: "linked-worktree",
        trustRoot,
        worktreeRoot: current
      };
      return await validateCriticalGitMetadata(workspace)
        ? { status: "verified", workspace: freezeVerifiedWorkspace(workspace, configOverrides) }
        : unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
    } catch {
      return unsafeInspection(current, GIT_METADATA_CONTAINMENT_FAILED_NOTE);
    }
  }
}

async function validateCriticalGitMetadata(workspace: VerifiedGitWorkspace): Promise<boolean> {
  if (
    !await isPhysicalDirectory(workspace.gitDir)
    || !await isPhysicalDirectory(workspace.commonDir)
    || !await isPhysicalDirectory(workspace.worktreeRoot)
  ) {
    return false;
  }

  const criticalFiles = new Set([
    path.join(workspace.gitDir, "HEAD"),
    path.join(workspace.gitDir, "index"),
    path.join(workspace.gitDir, "config.worktree"),
    path.join(workspace.commonDir, "config"),
    path.join(workspace.commonDir, "config.worktree"),
    path.join(workspace.commonDir, "info", "attributes"),
    path.join(workspace.commonDir, "info", "exclude"),
    path.join(workspace.commonDir, "packed-refs")
  ]);
  for (const filePath of criticalFiles) {
    if (!await isSingleLinkRegularFileOrMissing(filePath)) {
      return false;
    }
  }

  // Split indexes are selected by the contained index but read as sibling
  // metadata. Do not let one redirect Git through a symlink or hardlink.
  const gitDirEntries = await readdir(workspace.gitDir).catch(() => []);
  for (const entry of gitDirEntries) {
    if (/^sharedindex\.[0-9a-f]+$/i.test(entry)) {
      if (!await isSingleLinkRegularFileOrMissing(path.join(workspace.gitDir, entry))) {
        return false;
      }
    }
  }

  for (const directory of [
    path.join(workspace.commonDir, "objects"),
    path.join(workspace.commonDir, "refs")
  ]) {
    if (!await isPhysicalDirectoryOrMissing(directory)) {
      return false;
    }
  }

  const head = await readSingleLinkRegularFile(path.join(workspace.gitDir, "HEAD"), true);
  if (head && !await validateHeadReference(workspace, head.text)) {
    return false;
  }

  const alternatesPath = path.join(workspace.commonDir, "objects", "info", "alternates");
  if (!await isSingleLinkRegularFileOrMissing(alternatesPath)) {
    return false;
  }
  const alternates = await readSingleLinkRegularFile(alternatesPath, true);
  if (alternates && !await alternatesStayInsideCommonDir(workspace.commonDir, alternates.text)) {
    return false;
  }

  const overrides = await collectExecutableConfigOverrides(workspace);
  if (!overrides) {
    return false;
  }
  (workspace.configOverrides as string[]).push(...overrides);
  return true;
}

async function collectExecutableConfigOverrides(workspace: VerifiedGitWorkspace): Promise<string[] | null> {
  const filters = new Set<string>();
  const diffs = new Set<string>();
  for (const configPath of new Set([
    path.join(workspace.commonDir, "config"),
    path.join(workspace.gitDir, "config.worktree")
  ])) {
    const config = await readSingleLinkRegularFile(configPath, true);
    if (!config) continue;
    for (const line of config.text.split(/\r?\n/)) {
      if (/^\s*\[\s*include(?:\s*\]|if\b)/i.test(line)) {
        // Includes can introduce executable config from an unbound path after
        // this file was inspected. Provenance capture does not need them.
        return null;
      }
      const sectionStart = /^\s*\[\s*(filter|diff)\b/i.exec(line);
      if (!sectionStart) continue;
      const section = /^\s*\[\s*(filter|diff)\s+(?:"((?:\\.|[^"\\])*)"|\.\s*([^\]\s]+))\s*\]\s*(?:[#;].*)?$/i.exec(line);
      if (!section) return null;
      const rawDriver = section[2] === undefined ? section[3] : unescapeGitConfigSubsection(section[2]);
      if (!rawDriver || !/^[A-Za-z0-9_.-]+$/.test(rawDriver)) return null;
      if (section[1]?.toLowerCase() === "filter") filters.add(rawDriver);
      else diffs.add(rawDriver);
    }
  }

  const overrides: string[] = [];
  for (const driver of [...filters].sort()) {
    overrides.push(
      `filter.${driver}.clean=`,
      `filter.${driver}.smudge=`,
      `filter.${driver}.process=`,
      `filter.${driver}.required=false`
    );
  }
  for (const driver of [...diffs].sort()) {
    overrides.push(`diff.${driver}.command=`, `diff.${driver}.textconv=`);
  }
  return overrides;
}

function unescapeGitConfigSubsection(value: string): string | null {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped !== "\\" && escaped !== "\"") return null;
    result += escaped;
    index += 1;
  }
  return result;
}

function freezeVerifiedWorkspace(
  workspace: VerifiedGitWorkspace,
  configOverrides: string[]
): VerifiedGitWorkspace {
  Object.freeze(configOverrides);
  return Object.freeze(workspace);
}

async function validateHeadReference(workspace: VerifiedGitWorkspace, headText: string): Promise<boolean> {
  const value = headText.trim();
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) {
    return true;
  }
  if (!value.startsWith("ref: ")) {
    return false;
  }
  const ref = value.slice("ref: ".length);
  if (!isSafeGitRef(ref)) {
    return false;
  }

  // Normal branch refs live under the common directory. Per-worktree refs may
  // live under the admin directory. Validate either existing path without
  // requiring an unborn branch to have a loose ref.
  const candidates = [path.join(workspace.commonDir, ...ref.split("/"))];
  if (workspace.gitDir !== workspace.commonDir) {
    candidates.push(path.join(workspace.gitDir, ...ref.split("/")));
  }
  for (const candidate of candidates) {
    if (!await validateOptionalContainedFileChain(
      candidate.startsWith(`${workspace.gitDir}${path.sep}`) ? workspace.gitDir : workspace.commonDir,
      candidate
    )) {
      return false;
    }
  }
  return true;
}

async function validateOptionalContainedFileChain(root: string, filePath: string): Promise<boolean> {
  const relative = path.relative(root, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  let current = root;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT";
    }
    if (stats.isSymbolicLink()) return false;
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) return false;
    } else if (!stats.isFile() || stats.nlink !== 1n) {
      return false;
    }
  }
  return true;
}

async function alternatesStayInsideCommonDir(commonDir: string, text: string): Promise<boolean> {
  const objectDir = path.join(commonDir, "objects");
  for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const candidate = path.isAbsolute(line) ? line : path.resolve(objectDir, line);
    let physical: string;
    try {
      physical = await realpath(candidate);
    } catch {
      return false;
    }
    const relative = path.relative(commonDir, physical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
  }
  return true;
}

function parseGitdirFile(text: string): string | null {
  const match = /^gitdir:\s*([^\r\n]+)\r?\n?$/.exec(text);
  return match?.[1]?.trim() || null;
}

function parseSinglePathLine(text: string): string | null {
  const match = /^([^\r\n]+)\r?\n?$/.exec(text);
  return match?.[1]?.trim() || null;
}

function isSafeGitRef(value: string): boolean {
  return value.startsWith("refs/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.includes("//")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function readSingleLinkRegularFile(
  filePath: string,
  allowMissing = false
): Promise<{ readonly identity: FileIdentity; readonly text: string } | null> {
  let before;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (allowMissing && isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    return null;
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      return null;
    }
    const text = await handle.readFile("utf8");
    return Object.freeze({
      identity: Object.freeze({ dev: opened.dev, ino: opened.ino }),
      text
    });
  } finally {
    await handle.close();
  }
}

async function isSingleLinkRegularFileOrMissing(filePath: string): Promise<boolean> {
  let before;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    return false;
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return false;
  try {
    const opened = await handle.stat({ bigint: true });
    return opened.isFile()
      && opened.nlink === 1n
      && opened.dev === before.dev
      && opened.ino === before.ino;
  } finally {
    await handle.close();
  }
}

async function stillSameSingleLinkFile(filePath: string, identity: FileIdentity): Promise<boolean> {
  try {
    const stats = await lstat(filePath, { bigint: true });
    return !stats.isSymbolicLink()
      && stats.isFile()
      && stats.nlink === 1n
      && stats.dev === identity.dev
      && stats.ino === identity.ino;
  } catch {
    return false;
  }
}

async function isPhysicalDirectory(directory: string): Promise<boolean> {
  try {
    const stats = await lstat(directory);
    return !stats.isSymbolicLink() && stats.isDirectory() && await realpath(directory) === directory;
  } catch {
    return false;
  }
}

async function isPhysicalDirectoryOrMissing(directory: string): Promise<boolean> {
  try {
    const stats = await lstat(directory);
    return !stats.isSymbolicLink() && stats.isDirectory() && await realpath(directory) === directory;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function unsafeInspection(
  worktreeRoot: string,
  note: typeof GIT_METADATA_INSPECTION_FAILED_NOTE | typeof GIT_METADATA_CONTAINMENT_FAILED_NOTE
): GitWorkspaceInspection {
  return { note, status: "unsafe", worktreeRoot };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
