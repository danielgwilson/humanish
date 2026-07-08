// Local working-tree packaging for `subject.source: local-tree`.
//
// Enumeration produces ONE file list that drives BOTH the tar archive and the
// content digest (archiveSha256), so the digest can never diverge from what
// actually gets packed. A prior in-house harness reimplemented exclusion in a
// second, independent digest walker that could drift from what its tar
// `--exclude` flags actually excluded; this file is deliberately designed so
// that cannot happen: enumerateLocalTree() builds one entries array, and both
// the hash and the tar file list are derived from that same array.
//
// See docs/goals/local-tree-subject/goal.md ("Packing design") for the full
// contract implemented here. Node builtins only, no npm dependencies.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface LocalTreeEntry {
  relPath: string;
  kind: "file" | "symlink";
  size: number;
}

export interface LocalTreeGitInfo {
  commit: string;
  dirty: boolean;
}

export interface LocalTreeArchive {
  archivePath: string;
  /** 64 lowercase hex sha256, the provenance pin (not the repo's 16-char display digest). */
  archiveSha256: string;
  fileCount: number;
  totalBytes: number;
  /** Absent when root is not a git work tree. */
  git?: LocalTreeGitInfo;
}

export interface CreateLocalTreeArchiveOptions {
  /** Default: a fresh directory under os.tmpdir(). */
  outputPath?: string;
  /** Author-supplied path prefixes / basenames, on top of the always-on denylist. */
  extraExclude?: string[];
  /** Upload size cap. Default DEFAULT_LOCAL_TREE_MAX_ARCHIVE_BYTES (256 MiB). */
  maxArchiveBytes?: number;
}

/**
 * Path segments that are always excluded, wherever they appear in a relPath,
 * in both git and fallback enumeration modes. Not overridable by callers.
 */
export const LOCAL_TREE_DENYLIST_PATH_SEGMENTS = [".git", "node_modules", ".homun"] as const;

/**
 * Basename glob patterns (single leading or trailing `*` only) that are always
 * excluded, in both git and fallback enumeration modes. Not overridable by
 * callers. This is a safety net for secret-shaped files that were never
 * gitignored; in git mode `.gitignore` already handles the bulk (build output,
 * caches).
 */
export const LOCAL_TREE_DENYLIST_BASENAME_PATTERNS = [
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "*.keystore",
] as const;

/** Default upload size cap: 256 MiB. */
export const DEFAULT_LOCAL_TREE_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Enumerate the packable entries of a local working tree.
 *
 * When root is a git work tree, the list is `git ls-files --cached --others
 * --exclude-standard -z`: tracked files plus untracked-but-not-ignored files,
 * honoring .gitignore exactly as git does. Entries that no longer exist on
 * disk (staged deletes) are dropped, and entries that resolve to a directory
 * on disk (a nested repo or worktree boundary) are dropped rather than
 * recursed into.
 *
 * Otherwise, a recursive readdir walk applies only the always-on denylist
 * plus extraExclude; .gitignore semantics require git, so this fallback is
 * coarser by design.
 *
 * The always-on denylist is applied in both modes and is not overridable.
 * The returned entries are sorted bytewise by relPath.
 */
export function enumerateLocalTree(
  root: string,
  options: { extraExclude?: string[] } = {},
): { entries: LocalTreeEntry[]; git?: LocalTreeGitInfo } {
  const resolvedRoot = path.resolve(root);
  assertValidRoot(resolvedRoot);
  const extraExclude = options.extraExclude ?? [];

  if (isGitWorkTree(resolvedRoot)) {
    const entries = enumerateGitTree(resolvedRoot, extraExclude);
    return { entries, git: captureGitInfo(resolvedRoot) };
  }

  const entries: LocalTreeEntry[] = [];
  walkFallbackTree(resolvedRoot, "", extraExclude, entries);
  entries.sort(compareEntriesByRelPath);
  return { entries };
}

/**
 * Enumerate a local working tree and pack it into a gzipped tar archive,
 * computing archiveSha256 from the exact same entries list used for the tar
 * file list.
 *
 * Fails closed when: the root is missing or not a directory; enumeration
 * produces zero entries; or total packed bytes exceed maxArchiveBytes.
 */
export function createLocalTreeArchive(
  root: string,
  options: CreateLocalTreeArchiveOptions = {},
): LocalTreeArchive {
  const resolvedRoot = path.resolve(root);
  const extraExclude = options.extraExclude ?? [];
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_LOCAL_TREE_MAX_ARCHIVE_BYTES;

  const { entries, git } = enumerateLocalTree(
    resolvedRoot,
    extraExclude.length > 0 ? { extraExclude } : undefined,
  );

  if (entries.length === 0) {
    throw new Error(
      `Local tree root "${resolvedRoot}" produced zero packable entries after the always-on denylist` +
        (extraExclude.length > 0 ? " and extraExclude" : "") +
        "; local-tree packing requires at least one non-denylisted file or symlink.",
    );
  }

  // Check the cap from enumerated sizes BEFORE reading/hashing file bytes, so
  // an oversized tree fails closed without the cost of hashing all of it.
  const enumeratedBytes = entries.reduce((sum, entry) => (entry.kind === "file" ? sum + entry.size : sum), 0);
  if (enumeratedBytes > maxArchiveBytes) {
    throw new Error(
      `Local tree archive for "${resolvedRoot}" is ${enumeratedBytes} bytes, exceeding maxArchiveBytes ` +
        `(${maxArchiveBytes}); pass a larger maxArchiveBytes or exclude more paths via localTree.exclude.`,
    );
  }

  const { archiveSha256, totalBytes } = computeArchiveSha256(resolvedRoot, entries);

  const archivePath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(mkdtempSync(path.join(tmpdir(), "homun-local-tree-")), "source.tar.gz");
  mkdirSync(path.dirname(archivePath), { recursive: true });

  writeTarArchive(resolvedRoot, entries, archivePath);

  const fileCount = entries.length;

  return git
    ? { archivePath, archiveSha256, fileCount, totalBytes, git }
    : { archivePath, archiveSha256, fileCount, totalBytes };
}

function assertValidRoot(root: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(root);
  } catch {
    throw new Error(
      `Local tree root "${root}" does not exist or is not readable; local-tree packing requires an existing directory.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Local tree root "${root}" is not a directory; local-tree packing requires a directory root.`);
  }
}

function isGitWorkTree(root: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

function gitListFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const names = out
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
  // During an unresolved merge, `ls-files --cached` emits one entry per
  // conflict stage for the same path; pack each path exactly once.
  return [...new Set(names)];
}

function captureGitInfo(root: string): LocalTreeGitInfo {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString("utf8")
    .trim();
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
  return { commit, dirty: status.trim().length > 0 };
}

function enumerateGitTree(root: string, extraExclude: readonly string[]): LocalTreeEntry[] {
  const entries: LocalTreeEntry[] = [];
  for (const relPath of gitListFiles(root)) {
    if (isPathDenylisted(relPath, extraExclude)) {
      continue;
    }
    const absolutePath = path.join(root, relPath);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      // Staged delete: git still tracks it, but it is gone from disk.
      continue;
    }
    if (stat.isDirectory()) {
      // A nested repo or worktree boundary enumerates as a single
      // directory-shaped entry from git ls-files; never recurse into it.
      continue;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ relPath, kind: "symlink", size: stat.size });
      continue;
    }
    if (stat.isFile()) {
      entries.push({ relPath, kind: "file", size: stat.size });
    }
  }
  entries.sort(compareEntriesByRelPath);
  return entries;
}

function walkFallbackTree(
  root: string,
  relDir: string,
  extraExclude: readonly string[],
  out: LocalTreeEntry[],
): void {
  const absoluteDir = relDir ? path.join(root, relDir) : root;
  const names = readdirSync(absoluteDir).sort();
  for (const name of names) {
    const relPath = relDir ? `${relDir}/${name}` : name;
    if (isPathDenylisted(relPath, extraExclude)) {
      continue;
    }
    const absolutePath = path.join(root, relPath);
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      walkFallbackTree(root, relPath, extraExclude, out);
      continue;
    }
    if (stat.isSymbolicLink()) {
      out.push({ relPath, kind: "symlink", size: stat.size });
      continue;
    }
    if (stat.isFile()) {
      out.push({ relPath, kind: "file", size: stat.size });
    }
    // Sockets, fifos, and device files are silently skipped: neither a
    // regular file nor a symlink, so out of scope for packing.
  }
}

function basenameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

function matchesBasenamePattern(basename: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return basename.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith("*")) {
    return basename.endsWith(pattern.slice(1));
  }
  return basename === pattern;
}

function isDenylistedBasename(basename: string): boolean {
  return LOCAL_TREE_DENYLIST_BASENAME_PATTERNS.some((pattern) => matchesBasenamePattern(basename, pattern));
}

function isDenylistedSegment(relPath: string): boolean {
  const segments = relPath.split("/");
  return segments.some((segment) => (LOCAL_TREE_DENYLIST_PATH_SEGMENTS as readonly string[]).includes(segment));
}

function matchesExtraExclude(relPath: string, basename: string, extraExclude: readonly string[]): boolean {
  return extraExclude.some(
    (entry) => relPath === entry || relPath.startsWith(`${entry}/`) || basename === entry,
  );
}

function isPathDenylisted(relPath: string, extraExclude: readonly string[]): boolean {
  if (isDenylistedSegment(relPath)) {
    return true;
  }
  const basename = basenameOf(relPath);
  if (isDenylistedBasename(basename)) {
    return true;
  }
  return matchesExtraExclude(relPath, basename, extraExclude);
}

/** Bytewise (UTF-8) comparison, independent of locale/platform string ordering. */
function compareEntriesByRelPath(a: LocalTreeEntry, b: LocalTreeEntry): number {
  return Buffer.compare(Buffer.from(a.relPath, "utf8"), Buffer.from(b.relPath, "utf8"));
}

/**
 * sha256 over the sorted sequence of records:
 *   files:    kind\0relPath\0size\0<file bytes>\0
 *   symlinks: kind\0relPath\0<link target string>\0
 * Symlinks are never dereferenced: only their target path string is hashed,
 * never bytes at the target.
 */
function computeArchiveSha256(
  root: string,
  entries: readonly LocalTreeEntry[],
): { archiveSha256: string; totalBytes: number } {
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.relPath);
    if (entry.kind === "symlink") {
      const target = readlinkSync(absolutePath);
      hash.update(`symlink\0${entry.relPath}\0${target}\0`);
      continue;
    }
    hash.update(`file\0${entry.relPath}\0${entry.size}\0`);
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
    totalBytes += entry.size;
  }
  return { archiveSha256: hash.digest("hex"), totalBytes };
}

function writeTarArchive(root: string, entries: readonly LocalTreeEntry[], archivePath: string): void {
  const listDir = mkdtempSync(path.join(tmpdir(), "homun-local-tree-list-"));
  const listFile = path.join(listDir, "files.list");
  try {
    writeFileSync(listFile, `${entries.map((entry) => entry.relPath).join("\0")}\0`);

    const darwinArgs =
      process.platform === "darwin" ? ["--disable-copyfile", "--no-xattrs", "--no-mac-metadata"] : [];
    // -C must precede -T: both are position-sensitive in GNU tar, and names
    // read from -T resolve against the directory in effect at that point.
    // bsdtar tolerates either order; GNU tar does not.
    const args = [...darwinArgs, "-czf", archivePath, "-C", root, "--null", "-T", listFile];

    try {
      execFileSync("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw new Error(`Failed to create local-tree tar archive at "${archivePath}": ${tarErrorTail(error)}`);
    }
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
}

function tarErrorTail(error: unknown): string {
  const stderr =
    error && typeof error === "object" && "stderr" in error && (error as { stderr?: unknown }).stderr instanceof Buffer
      ? (error as { stderr: Buffer }).stderr.toString("utf8")
      : error instanceof Error
        ? error.message
        : String(error);
  return stderr.trim().slice(-400);
}
