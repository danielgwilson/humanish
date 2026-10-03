// `humanish migrate`: convert humanish.lab.v2 study files to humanish.study.v3. A file under a
// labs/ directory moves to the matching studies/ directory; any other file is rewritten in place.
// It runs in four phases, and a phase that fails leaves every source file where it was:
// 1. Plan: read, convert and plan-check every file, and record each source's identity. No writes.
// 2. Stage: write each output to a new temp file beside its destination. A failure removes them.
// 3. Commit: recheck each source. A rewritten source is first renamed to a random hidden name and
//    checked there. Then the new file is linked into place, which fails if anything holds that
//    name, so no file this run did not write is ever overwritten. A failure undoes the commits.
// 4. Clean up: delete each moved source and each rewrite's original, once checked (owned-files.ts).
//    A file that changed since the plan is kept and listed; a rewrite's original as <name>.v2.bak.

import { randomUUID } from "node:crypto";
import { link, lstat, readdir, readFile, realpath, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import type { StudyRoute } from "./parse/study-v3.js";
import { isNodeError } from "../run/type-guards.js";
import { convertStudyText, isStudyV3, type DroppedKey, type MovedKey } from "./convert.js";
import { otherStudyFiles, STUDY_DIRECTORIES, studyFileStem } from "./files.js";
import {
  assertDirectory,
  bindDirectory,
  exists,
  fileIdentity,
  NO_HARD_LINKS,
  removeChecked,
  removeOwned,
  restoreName,
  sameFile,
  sha256,
  writeOwned,
  type DirectoryIdentity,
  type FileIdentity,
  type LinkFile,
  type OwnedFile,
} from "./owned-files.js";

/** The schema of `humanish migrate --json`. */
const MIGRATE_SCHEMA = "humanish.migrate-result.v1";

/** One file migrate looked at. Paths are relative to the project. */
export interface MigrateFile {
  readonly source: string;
  /** `move` to a studies/ directory, `rewrite` in place, or `skip` a v3 file. */
  readonly action: "move" | "rewrite" | "skip";
  readonly destination?: string;
  readonly route?: StudyRoute;
  readonly moved: readonly MovedKey[];
  readonly dropped: readonly DroppedKey[];
}

/** What migrate did, or would do with `--dry-run`. */
export interface MigrateResult {
  readonly schema: typeof MIGRATE_SCHEMA;
  readonly ok: boolean;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly files: readonly MigrateFile[];
  /** Files left behind after a clean-up step found them changed: sources, backups or temp files. */
  readonly unresolved?: readonly string[];
  readonly error?: {
    readonly code: "HUMANISH_MIGRATE_REFUSED" | "HUMANISH_MIGRATE_FAILED";
    readonly phase: "plan" | "stage" | "commit" | "clean-up";
    readonly file?: string;
    readonly message: string;
  };
}

/** How to run migrate. */
export interface MigrateOptions {
  readonly cwd: string;
  /** Files to convert. Without any, the six study directories are scanned. */
  readonly paths?: readonly string[];
  readonly dryRun?: boolean;
  /** Called with the plan before anything is written, so a caller can print every destination. */
  readonly onPlan?: (files: readonly MigrateFile[]) => void;
  /** Replaces `fs.link`. Tests use it to stand in for a filesystem without hard links. */
  readonly link?: (from: string, to: string) => Promise<void>;
  /** Called between stage and commit, and between commit and clean-up. Tests change files there. */
  readonly onPhase?: (finished: "stage" | "commit") => void;
  /** Called for each file after its last check and before its commit changes anything. Tests race it. */
  readonly onCommit?: (source: string) => Promise<void> | void;
}

interface PlannedWrite {
  readonly file: MigrateFile;
  readonly sourcePath: string;
  readonly sourceDirectory: DirectoryIdentity;
  readonly sourceIdentity: FileIdentity;
  readonly sourceMode: number;
  readonly destinationPath: string;
  /** Where a rewrite's source waits, under a name no other process uses, until its new file is in. */
  readonly asidePath: string;
  /** `<source>.v2.bak`: the name a rewrite's source keeps when a failure leaves it out of place. */
  readonly backupPath: string;
  readonly text: string;
  /** sha256 of `text`, the bytes every staged and committed copy must hold. */
  readonly expected: string;
  destinationDirectory?: DirectoryIdentity | undefined;
  temp?: OwnedFile | undefined;
  /** Whether a rewrite's source is at `asidePath`. */
  movedAside?: boolean;
  /** The v3 file in place: set the moment its link or copy succeeds. */
  committed?: FileIdentity | undefined;
  /** A temp file name another file took before this run could remove it. */
  leftover?: string | undefined;
}

class MigrateError extends Error {
  constructor(
    readonly phase: NonNullable<MigrateResult["error"]>["phase"],
    readonly file: string | undefined,
    message: string,
    readonly refused = false,
    readonly unresolved: readonly string[] = [],
  ) {
    super(message);
  }
}

const LABS_TO_STUDIES = new Map(
  STUDY_DIRECTORIES.filter((directory) => directory.family === "labs").map((directory) => [
    directory.relativeDir,
    directory.relativeDir.replace(/labs$/, "studies"),
  ]),
);

async function scanTargets(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const directory of STUDY_DIRECTORIES) {
    const bound = await bindDirectory(root, directory.relativeDir);
    if (bound === undefined) continue;
    for (const name of (await readdir(bound.physicalPath)).sort()) {
      if (studyFileStem(name) !== undefined) found.push(path.join(directory.relativeDir, name));
    }
  }
  return found;
}

async function givenTargets(root: string, paths: readonly string[]): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const given of paths) {
    const absolute = path.resolve(root, given);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new MigrateError("plan", given, `${given} is outside the project.`, true);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw new MigrateError("plan", given, `${given} does not exist.`, true);
    }
    if (!seen.has(real)) seen.set(real, relative);
  }
  return [...seen.values()];
}

async function planWrites(
  root: string,
  options: MigrateOptions,
): Promise<{
  files: MigrateFile[];
  writes: PlannedWrite[];
}> {
  const targets =
    options.paths && options.paths.length > 0
      ? await givenTargets(root, options.paths)
      : await scanTargets(root);
  const files: MigrateFile[] = [];
  const writes: PlannedWrite[] = [];
  for (const source of targets) {
    const sourcePath = path.join(root, source);
    let sourceDirectory: DirectoryIdentity | undefined;
    let identity: FileIdentity;
    let mode: number;
    let bytes: Buffer;
    try {
      sourceDirectory = await bindDirectory(root, path.dirname(source));
      if (sourceDirectory === undefined) throw new Error("its directory is missing");
      identity = await fileIdentity(sourcePath);
      mode = Number((await lstat(sourcePath)).mode & 0o777);
      bytes = await readFile(sourcePath);
      if (sha256(bytes) !== identity.sha256) throw new Error("it changed while it was read");
    } catch (error) {
      throw new MigrateError("plan", source, `${source}: ${(error as Error).message}.`, true);
    }
    const text = bytes.toString("utf8");
    if (isStudyV3(parseDocument(text).toJS())) {
      files.push({ source, action: "skip", moved: [], dropped: [] });
      continue;
    }
    const converted = convertStudyText(text, root);
    if (!converted.ok)
      throw new MigrateError(
        "plan",
        source,
        `${source} was not converted: ${converted.reason}`,
        true,
      );
    const studiesDir = LABS_TO_STUDIES.get(path.dirname(source));
    const destination =
      studiesDir === undefined ? source : path.join(studiesDir, path.basename(source));
    const file: MigrateFile = {
      source,
      action: studiesDir === undefined ? "rewrite" : "move",
      destination,
      route: converted.conversion.route,
      moved: converted.conversion.moved,
      dropped: converted.conversion.dropped,
    };
    files.push(file);
    writes.push({
      file,
      sourcePath,
      sourceDirectory: sourceDirectory!,
      sourceIdentity: identity,
      sourceMode: mode,
      destinationPath: path.join(root, destination),
      asidePath: path.join(
        path.dirname(sourcePath),
        `.${path.basename(sourcePath)}.migrate-${randomUUID()}.orig`,
      ),
      backupPath: `${sourcePath}.v2.bak`,
      text: converted.conversion.text,
      expected: sha256(Buffer.from(converted.conversion.text)),
    });
  }
  await refuseCollisions(root, writes);
  return { files, writes };
}

// A destination two files share, or a name another file already uses, would leave discovery two
// files for one study. Files that move together are not collisions with each other.
async function refuseCollisions(root: string, writes: readonly PlannedWrite[]): Promise<void> {
  const sources = new Set(writes.map((write) => write.file.source));
  const destinations = new Map<string, string>();
  for (const write of writes) {
    const destination = write.file.destination!;
    const stem = studyFileStem(path.basename(destination));
    // A file without a study extension has no stem, so only its exact path can collide.
    const sameStem =
      stem === undefined
        ? undefined
        : [...destinations.entries()].find(
            ([other]) =>
              path.dirname(other) === path.dirname(destination) &&
              studyFileStem(path.basename(other)) === stem,
          );
    if (destinations.has(destination) || sameStem) {
      const other = destinations.get(destination) ?? sameStem![1];
      const clash = destinations.has(destination)
        ? `would both become ${destination}`
        : `would share the name ${studyFileStem(path.basename(destination))} in ${path.dirname(destination)}`;
      throw new MigrateError(
        "plan",
        write.file.source,
        `${write.file.source} and ${other} ${clash}. Remove one, then migrate.`,
        true,
      );
    }
    destinations.set(destination, write.file.source);
    const others = await collisions(root, write, sources);
    const blocking =
      write.file.action === "move" && (await exists(write.destinationPath))
        ? [write.file.destination!, ...others]
        : others;
    if (blocking.length > 0) {
      throw new MigrateError(
        "plan",
        write.file.source,
        `${write.file.source} and ${blocking[0]} share the name ${stem ?? path.basename(destination)}. Keep one, then migrate.`,
        true,
      );
    }
  }
}

async function stage(root: string, writes: PlannedWrite[], created: string[]): Promise<void> {
  for (const write of writes) {
    try {
      write.destinationDirectory = await bindDirectory(
        root,
        path.dirname(write.file.destination!),
        created,
      );
      write.temp = {
        path: path.join(
          path.dirname(write.destinationPath),
          `.${path.basename(write.destinationPath)}.migrate-${randomUUID()}.tmp`,
        ),
      };
      await writeOwned(write.temp, write.text, write.sourceMode);
    } catch (error) {
      throw new MigrateError(
        "stage",
        write.file.source,
        `${write.file.source}: ${(error as Error).message}.`,
      );
    }
  }
}

// After a failed stage or commit: remove each temp file. One this run did not write, or that
// changed, is kept and listed.
async function unstage(
  root: string,
  writes: readonly PlannedWrite[],
  created: readonly string[],
  linkFile: LinkFile,
): Promise<string[]> {
  const kept: string[] = [];
  for (const write of writes) {
    if (write.temp === undefined) continue;
    const left = await removeOwned(write.temp, linkFile).catch(() => write.temp!.path);
    if (left !== undefined) kept.push(path.relative(root, left));
  }
  for (const directory of [...created].reverse()) await rmdir(directory).catch(() => undefined);
  return kept;
}

// Put the staged file at its destination without replacing anything there.
async function placeNew(root: string, write: PlannedWrite, linkFile: LinkFile): Promise<void> {
  const taken = () =>
    new Error(
      `${path.relative(root, write.destinationPath)} appeared while ${write.file.source} was migrated; both are kept`,
    );
  try {
    await linkFile(write.temp!.path, write.destinationPath);
    // The temp file's name goes once every file is committed (commit), checked like any removal.
    write.committed = write.temp!.identity;
    return;
  } catch (error) {
    if (write.committed !== undefined) throw error;
    if (isNodeError(error) && error.code === "EEXIST") throw taken();
    if (!(isNodeError(error) && NO_HARD_LINKS.has(error.code ?? ""))) throw error;
    const copy: OwnedFile = { path: write.destinationPath };
    try {
      await writeOwned(copy, write.text, write.sourceMode);
    } catch (copyError) {
      if (copy.inode === undefined && isNodeError(copyError) && copyError.code === "EEXIST")
        throw taken();
      // A copy this run created but could not finish or read back is removed, if it is unchanged.
      if (copy.inode !== undefined) await removeOwned(copy, linkFile).catch(() => undefined);
      throw copyError;
    }
    write.committed = copy.identity;
  }
}

// Every name that would collide with this write's destination, other than the files this run moves
// or writes. Checked at plan time and again just before each commit.
async function collisions(
  root: string,
  write: PlannedWrite,
  ours: ReadonlySet<string>,
): Promise<string[]> {
  if (
    !STUDY_DIRECTORIES.some(
      (directory) => directory.relativeDir === path.dirname(write.file.destination!),
    )
  )
    return [];
  // Discovery reads only .yaml and .yml files, so a file without that extension shares no name.
  const stem = studyFileStem(path.basename(write.file.destination!));
  if (stem === undefined) return [];
  return (
    await otherStudyFiles(
      stem,
      (candidate) => exists(path.join(root, candidate)),
      write.file.source,
    )
  ).filter((other) => !ours.has(other));
}

// Move a rewrite's source to its aside name, then check that the file moved is the one the plan
// read. An edit saved in between is given its name back, never overwritten.
async function moveAside(write: PlannedWrite, linkFile: LinkFile): Promise<void> {
  await rename(write.sourcePath, write.asidePath);
  write.movedAside = true;
  const moved = await fileIdentity(write.asidePath).catch(() => undefined);
  if (moved !== undefined && sameFile(moved, write.sourceIdentity)) return;
  if (await restoreName(write.asidePath, write.sourcePath, linkFile)) write.movedAside = false;
  throw new Error(`${write.file.source} changed after it was planned`);
}

// A rewrite's source that cannot get its name back is kept as <name>.v2.bak, or under its aside
// name when that is taken too. Returns where it is.
async function keepOriginal(write: PlannedWrite, linkFile: LinkFile): Promise<string> {
  const kept = (await restoreName(write.asidePath, write.backupPath, linkFile).catch(() => false))
    ? write.backupPath
    : write.asidePath;
  write.movedAside = false;
  return kept;
}

async function commit(
  root: string,
  writes: PlannedWrite[],
  linkFile: LinkFile,
  onCommit: MigrateOptions["onCommit"],
): Promise<void> {
  const ours = new Set(writes.flatMap((write) => [write.file.source, write.file.destination!]));
  try {
    for (const write of writes) {
      await assertDirectory(write.sourceDirectory, root);
      await assertDirectory(write.destinationDirectory!, root);
      if (!sameFile(await fileIdentity(write.temp!.path, true), write.temp!.identity!))
        throw new Error(`the staged copy of ${write.file.source} changed`);
      const other = (await collisions(root, write, ours))[0];
      if (other !== undefined)
        throw new Error(`${other} appeared with the name of ${write.file.destination}`);
      if (!sameFile(await fileIdentity(write.sourcePath), write.sourceIdentity))
        throw new Error(`${write.file.source} changed after it was planned`);
      await onCommit?.(write.file.source);
      if (write.file.action === "rewrite") await moveAside(write, linkFile);
      await placeNew(root, write, linkFile);
    }
    for (const write of writes) {
      if (write.temp === undefined) continue;
      write.leftover = await removeOwned(write.temp, linkFile).catch(() => write.temp!.path);
      write.temp = undefined;
    }
  } catch (error) {
    const unrestored = await undoCommits(root, writes, linkFile);
    throw new MigrateError(
      "commit",
      undefined,
      unrestored.length === 0
        ? `${(error as Error).message}. Every source is where it was.`
        : `${(error as Error).message}. These files could not be put back: ${unrestored.join(", ")}.`,
      false,
      unrestored,
    );
  }
}

// Undo each commit, last first: remove each new file that is still the one this run wrote, and give
// each rewritten source its name back. A name another file now holds is left alone, and the source
// is kept beside it. One failure does not stop the rest. Returns the paths it could not put back.
async function undoCommits(
  root: string,
  writes: readonly PlannedWrite[],
  linkFile: LinkFile,
): Promise<string[]> {
  const unrestored: string[] = [];
  const keep = (file: string) => unrestored.push(path.relative(root, file));
  for (const write of [...writes].reverse()) {
    try {
      const committed = write.committed;
      if (committed !== undefined) {
        const kept = await removeChecked(
          write.destinationPath,
          (current) => sameFile(current, committed),
          linkFile,
        );
        write.committed = undefined;
        if (kept !== undefined) {
          keep(kept);
          if (write.movedAside === true) keep(await keepOriginal(write, linkFile));
          continue;
        }
      }
      if (write.movedAside !== true) continue;
      if (await restoreName(write.asidePath, write.sourcePath, linkFile)) write.movedAside = false;
      else keep(await keepOriginal(write, linkFile));
    } catch {
      keep(
        write.committed !== undefined
          ? write.destinationPath
          : write.movedAside === true
            ? write.asidePath
            : write.sourcePath,
      );
    }
  }
  return unrestored;
}

// Delete each moved source and each rewrite's original, but only once the v3 file is in place as
// written, and only if the old file is still the one the plan read (removeChecked). Anything kept
// is listed; a rewrite's original is kept as <name>.v2.bak.
async function cleanUp(
  root: string,
  writes: readonly PlannedWrite[],
  linkFile: LinkFile,
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const write of writes) {
    if (write.leftover !== undefined) unresolved.push(path.relative(root, write.leftover));
    const old = write.file.action === "move" ? write.sourcePath : write.asidePath;
    let kept: string | undefined = old;
    try {
      const placed = await fileIdentity(write.destinationPath, true);
      if (!sameFile(placed, write.committed!)) throw new Error("the new file changed");
      await assertDirectory(write.sourceDirectory, root);
      // A rename keeps the inode, so a rewrite's original still has its source's identity.
      kept = await removeChecked(
        old,
        (current) => sameFile(current, write.sourceIdentity),
        linkFile,
      );
    } catch {
      kept = old;
    }
    if (kept === undefined) continue;
    if (kept === write.asidePath) kept = await keepOriginal(write, linkFile);
    unresolved.push(path.relative(root, kept));
  }
  return unresolved;
}

/** Convert the selected v2 study files to v3. */
export async function migrateStudies(options: MigrateOptions): Promise<MigrateResult> {
  const root = await realpath(path.resolve(options.cwd)).catch(() => path.resolve(options.cwd));
  const base = { schema: MIGRATE_SCHEMA, cwd: root, dryRun: options.dryRun === true } as const;
  let files: MigrateFile[] = [];
  const created: string[] = [];
  let writes: PlannedWrite[] = [];
  const linkFile = options.link ?? link;
  try {
    ({ files, writes } = await planWrites(root, options));
    options.onPlan?.(files);
    if (options.dryRun === true || writes.length === 0) return { ...base, ok: true, files };
    try {
      await stage(root, writes, created);
      options.onPhase?.("stage");
      await commit(root, writes, linkFile, options.onCommit);
    } catch (error) {
      const kept = await unstage(root, writes, created, linkFile);
      if (kept.length > 0 && error instanceof MigrateError) {
        throw new MigrateError(
          error.phase,
          error.file,
          `${error.message} Kept for you to check: ${kept.join(", ")}.`,
          error.refused,
          [...error.unresolved, ...kept],
        );
      }
      throw error;
    }
    options.onPhase?.("commit");
    const unresolved = await cleanUp(root, writes, linkFile);
    if (unresolved.length > 0) {
      return {
        ...base,
        ok: false,
        files,
        unresolved,
        error: {
          code: "HUMANISH_MIGRATE_FAILED",
          phase: "clean-up",
          message: `Every study was written, but these files changed since the plan and were kept: ${unresolved.join(", ")}. Check them, then delete them.`,
        },
      };
    }
    return { ...base, ok: true, files };
  } catch (error) {
    const failure =
      error instanceof MigrateError
        ? error
        : new MigrateError("plan", undefined, (error as Error).message);
    return {
      ...base,
      ok: false,
      files,
      ...(failure.unresolved.length === 0 ? {} : { unresolved: failure.unresolved }),
      error: {
        code: failure.refused ? "HUMANISH_MIGRATE_REFUSED" : "HUMANISH_MIGRATE_FAILED",
        phase: failure.phase,
        ...(failure.file === undefined ? {} : { file: failure.file }),
        message: failure.message,
      },
    };
  }
}
