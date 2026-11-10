// Copying a remote run's evidence from its runner to this machine: while the run goes on, what has
// settled, and when it ends, everything else, each file checked against the runner's digest.
import { constants } from "node:fs";
import { open, readFile, readdir, rename, statfs, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { sha256OfOpenedFile } from "../observer/pinned-files.js";
import {
  RUN_ARTIFACT_MAX_BYTES,
  openContainedRegularFile,
  prepareContainedOutputFile,
  readContainedRegularFile,
  removeContainedOutputFile,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { pointLatestRunAt } from "../run/run.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../run/sandbox-receipts.js";
import {
  COPY_BATCH_BYTES,
  CopiedFileDamagedError,
  listRemoteRun,
  listSettledEvidence,
  readRemoteBytes,
  readRemoteFileInRanges,
  readRemoteFiles,
  type RangeRetry,
  type RemoteFile,
  type Runner,
} from "./runner.js";

/** How long a screenshot or recording must be unchanged before it is copied mid-run. */
const SETTLED_SECONDS = 10;
/** Left free on this machine by a copy, for everything else that needs the disk. */
const RESERVED_DISK_BYTES = 1024 ** 3;
const PARTIAL_PREFIX = ".copy-";

const statfsFreeBytes = async (directory: string): Promise<number> => {
  const { bavail, bsize } = await statfs(directory);
  return bavail * bsize;
};

export interface CopyOptions {
  retry?: RangeRetry;
  /** The space free on the disk that holds the run. */
  freeBytes?: (directory: string) => Promise<number>;
}

/**
 * Copy every file of the runner's run directory into this machine's run directory, each checked
 * against the digest the runner listed. The sandbox journal keeps this machine's lines (the
 * runner's own receipt) and adds the runner's (its participants'). A file copied while the run went
 * on that the runner no longer has, a frame's PNG replaced by its WebP, is removed here too.
 */
export async function copyRunBack(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  copiedWhileRunning: ReadonlyMap<string, number>,
  say: (line: string) => void,
  options: CopyOptions = {},
): Promise<{ files: number; alreadyHere: number }> {
  const files = await listRemoteRun(runner, runId);
  let alreadyHere = 0;
  const wanted: RemoteFile[] = [];
  for (const file of files) {
    if (file.path === "owner-key") continue;
    // Already here with the same bytes, copied while the run went on or by an earlier attempt.
    if (file.path !== SANDBOX_RECEIPTS_ARTIFACT && (await localDigest(paths, file)) === file.sha256)
      alreadyHere += 1;
    else wanted.push(file);
  }
  const copiedInRanges = (file: RemoteFile) =>
    file.size > COPY_BATCH_BYTES && file.path !== SANDBOX_RECEIPTS_ARTIFACT;
  await readRemoteFiles(
    runner,
    runId,
    wanted.filter((file) => !copiedInRanges(file)),
    async (file, bytes) => {
      if (file.path !== SANDBOX_RECEIPTS_ARTIFACT)
        return await writeContainedOutputFile(paths, file.path, bytes);
      const local = await readContainedRegularFile(paths, file.path, 16 * 1024 * 1024);
      const mine = local.status === "read" ? Buffer.from(local.bytes).toString("utf8") : "";
      await writeContainedOutputFile(
        paths,
        file.path,
        joinJournals(mine, Buffer.from(bytes).toString("utf8")),
        "utf8",
      );
    },
  );
  for (const file of wanted.filter(copiedInRanges)) {
    say(`Copying ${file.path} (${Math.ceil(file.size / 1024 ** 2)} MiB) from the runner.`);
    await saveInRanges(runner, paths, runId, file, options);
  }
  const listed = new Set(files.map((file) => file.path));
  for (const file of copiedWhileRunning.keys())
    if (!listed.has(file)) await removeContainedOutputFile(paths, file);
  await pointLatestRunAt(paths, runId);
  await updateRemoteRecord(paths, ({ copyPending: _done, ...record }) => record);
  return { files: files.length, alreadyHere };
}

/** Rewrites this run's remote.json; a run without one, which only tests make, is left alone. */
async function updateRemoteRecord(
  paths: PreparedRunArtifactPaths,
  change: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const read = await readContainedRegularFile(paths, "remote.json", 1024 * 1024);
  if (read.status !== "read") return;
  const record = JSON.parse(Buffer.from(read.bytes).toString("utf8")) as Record<string, unknown>;
  await writeContainedOutputFile(
    paths,
    "remote.json",
    `${JSON.stringify(change(record), null, 2)}\n`,
    "utf8",
  );
}

/**
 * The runner is gone, so the copy can never finish. Each recording the bundle names that did not
 * arrive is recorded as lost, so verify and the Observer can still read everything that did.
 */
export async function giveUpCopy(paths: PreparedRunArtifactPaths): Promise<string[]> {
  const read = await readContainedRegularFile(paths, "run.json", RUN_ARTIFACT_MAX_BYTES);
  const lost: string[] = [];
  if (read.status === "read") {
    const bundle = JSON.parse(Buffer.from(read.bytes).toString("utf8")) as {
      streams?: Array<{ recording?: { path?: unknown } }>;
    };
    for (const stream of bundle.streams ?? []) {
      const recording = stream.recording?.path;
      if (typeof recording !== "string") continue;
      const handle = await openContainedRegularFile(paths, recording);
      if (handle === null) {
        lost.push(recording);
        const target = await prepareContainedOutputFile(paths, recording);
        await removePartials(path.dirname(target)).catch(() => undefined);
      }
      await handle?.close();
    }
  }
  await updateRemoteRecord(paths, ({ copyPending: _done, ...record }) => ({
    ...record,
    ...(lost.length === 0 ? {} : { lostInCopy: lost }),
  }));
  return lost;
}

/**
 * Writes a large file beside its destination and renames it once the saved bytes match the listed
 * digest. The partial file is named by the content it will hold, so a copy that was killed is
 * picked up at its last whole range. A file the digest refuses is removed, so the next copy starts
 * over. Every step goes through one descriptor opened without following a link, so a path swapped
 * after it was checked cannot redirect the truncate.
 */
async function saveInRanges(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  file: RemoteFile,
  options: CopyOptions,
): Promise<void> {
  const target = await prepareContainedOutputFile(paths, file.path);
  const folder = path.posix.dirname(file.path);
  const name = `${PARTIAL_PREFIX}${file.sha256.slice(0, 32)}`;
  const temporary = await prepareContainedOutputFile(paths, path.posix.join(folder, name));
  const lock = await prepareContainedOutputFile(paths, path.posix.join(folder, `${name}.lock`));
  await takeCopyLock(lock, file.path);
  let handle: FileHandle | undefined;
  let discard = false;
  try {
    handle = await open(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    const firstRange = Math.floor((await handle.stat()).size / COPY_BATCH_BYTES);
    const savedBytes = firstRange * COPY_BATCH_BYTES;
    await handle.truncate(savedBytes);
    const free = await (options.freeBytes ?? statfsFreeBytes)(path.dirname(temporary));
    const needed = file.size - savedBytes;
    if (free - RESERVED_DISK_BYTES < needed)
      throw new Error(
        `this machine has ${gib(free)} free and ${file.path} needs ${gib(needed)} more, leaving 1 GiB free. Free some disk, then run humanish observe --run ${runId} to finish the copy`,
      );
    const writing = handle;
    await readRemoteFileInRanges(runner, runId, file, (range) => writing.appendFile(range), {
      firstRange,
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
    if ((await sha256OfOpenedFile(handle)) !== file.sha256)
      throw new CopiedFileDamagedError(
        `${file.path} changed or arrived damaged while it was copied from the runner.`,
      );
    await handle.close();
    if ((await prepareContainedOutputFile(paths, file.path)) !== target)
      throw new Error(`${file.path} changed on this machine while it was copied.`);
    await rename(temporary, target);
    await removePartials(path.dirname(target));
  } catch (error) {
    discard = error instanceof CopiedFileDamagedError;
    throw error;
  } finally {
    const saved = await handle?.stat().then(
      (stats) => stats.size,
      () => undefined,
    );
    await handle?.close().catch(() => undefined);
    if (discard || saved === 0) await unlink(temporary).catch(() => undefined);
    await unlink(lock).catch(() => undefined);
  }
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Two commands appending to one partial file would double its ranges. A lock held by a process that
 * has died, as a killed launcher's is, is taken over.
 */
async function takeCopyLock(lock: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(
        lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
    }
    const owner = Number(await readFile(lock, "utf8").catch(() => ""));
    if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner))
      throw new Error(`another humanish process is already copying ${file}`);
    await unlink(lock).catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes partial files beside a finished video, as a version that named them at random left. */
async function removePartials(folder: string): Promise<void> {
  for (const name of await readdir(folder))
    if (name.startsWith(PARTIAL_PREFIX))
      await unlink(path.join(folder, name)).catch(() => undefined);
}

/**
 * Copy the run's screenshots and recordings that have settled and are not here yet, while the run
 * goes on, so the copy at its end is only what is left. Each file the runner sends is an answer, so
 * a long catch-up after a sleep does not count against it. A file too large to read at once waits
 * for the end of the run, since copying it here would hold up following the run for minutes.
 */
export async function copySettledEvidence(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  copied: Map<string, number>,
  answered: () => void,
): Promise<void> {
  const settled = await listSettledEvidence(runner, runId, SETTLED_SECONDS);
  answered();
  for (const file of settled) {
    if (copied.get(file.path) === file.size || file.size > COPY_BATCH_BYTES) continue;
    const bytes = await readRemoteBytes(runner, runId, file.path);
    answered();
    await writeContainedOutputFile(paths, file.path, bytes);
    copied.set(file.path, file.size);
  }
}

/** This machine's copy's sha256; a copy of another size is known to differ without reading it. */
async function localDigest(
  paths: PreparedRunArtifactPaths,
  file: RemoteFile,
): Promise<string | undefined> {
  const handle = await openContainedRegularFile(paths, file.path);
  if (handle === null) return undefined;
  try {
    return (await handle.stat()).size === file.size ? await sha256OfOpenedFile(handle) : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Two sandbox journals as one: every line of each, in order, once. A copy that runs again adds
 * nothing it already added.
 */
export function joinJournals(...journals: string[]): string {
  const lines = [
    ...new Set(
      journals.flatMap((journal) => journal.split("\n")).filter((line) => line.trim() !== ""),
    ),
  ];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
