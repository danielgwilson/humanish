import { createReadStream } from "node:fs";
import { rmSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  statfs,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fragmentEndMs } from "./fragmented-mp4.js";

const SEGMENT_NAME = /^seg[0-9]{6}\.m4s$/;

interface RecordingSegment {
  name: string;
  durationMs: number;
}

export interface RecordingPlaylist {
  segments: RecordingSegment[];
  ended: boolean;
}

/** The recorder's segment playlist: only finished segments are listed, oldest first. */
export function parseRecordingPlaylist(text: string): RecordingPlaylist {
  const segments: RecordingSegment[] = [];
  let ended = false;
  let pendingSeconds: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "#EXT-X-ENDLIST") ended = true;
    const length = /^#EXTINF:([0-9]+(?:\.[0-9]+)?),/.exec(line);
    if (length) pendingSeconds = Number(length[1]);
    if (line === "" || line.startsWith("#")) continue;
    if (pendingSeconds === undefined || !SEGMENT_NAME.test(line))
      throw new Error("Desktop recording playlist was invalid.");
    segments.push({ name: line, durationMs: Math.round(pendingSeconds * 1000) });
    pendingSeconds = undefined;
  }
  return { segments, ended };
}

const INIT_NAME = "init.mp4";
/** How far a fragment's time may run past the wall clock before it is not believed. */
const CLOCK_ALLOWANCE_MS = 60_000;

/** Left free for the run's screenshots and traces, which matter more than its video. */
const RESERVED_DISK_BYTES = 1024 ** 3;
// Every video held here is written out once more when its participant ends, so each spool leaves
// room for all of them.
let heldBytes = 0;

const statfsFreeBytes = async (directory: string): Promise<number> => {
  const { bavail, bsize } = await statfs(directory);
  return bavail * bsize;
};

// One listener for every participant: a listener each would pass Node's warning count.
const liveDirectories = new Set<string>();
let exitCleanupInstalled = false;
function removeOnExit(directory: string): void {
  liveDirectories.add(directory);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const live of liveDirectories) rmSync(live, { recursive: true, force: true });
  });
}

const SPOOL_PREFIX = "humanish-recording-";
const SPOOL_OWNER_FILE = "owner";
/** For a spool from a version that recorded no owner: it was written to every few seconds. */
const ABANDONED_SPOOL_MS = 24 * 3_600_000;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether nothing can still be using this spool: its owner is gone, or it has none and is old. */
async function spoolIsAbandoned(directory: string): Promise<boolean> {
  const owner = Number(
    await readFile(path.join(directory, SPOOL_OWNER_FILE), "utf8").catch(() => ""),
  );
  if (Number.isInteger(owner) && owner > 0) return !pidIsAlive(owner);
  const written = await lstat(path.join(directory, "desktop.mp4"))
    .catch(() => lstat(directory))
    .then((stats) => stats.mtimeMs)
    .catch(() => Date.now());
  return Date.now() - written > ABANDONED_SPOOL_MS;
}

/**
 * Removes spools a killed process could not clean up. Each can hold a whole video, and the exit
 * handler above never runs for a SIGKILL, an out-of-memory kill or a lost machine.
 */
async function removeAbandonedSpools(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(SPOOL_PREFIX)) continue;
    const directory = path.join(root, name);
    if (await spoolIsAbandoned(directory))
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What a sandbox offers the spool. Every method may reject while the sandbox is unreachable. */
export interface RecordingPieces {
  playlist(): Promise<string>;
  read(name: string): Promise<Buffer>;
  remove(names: readonly string[]): Promise<void>;
}

interface RecordingSpoolResult {
  bytes: number;
  durationMs: number;
  /** True only when the recorder closed the video and every segment was kept. */
  ended: boolean;
}

export interface RecordingSpool {
  /** Copies every newly finished segment here. Pulls run one at a time; failures retry on the next. */
  pull(): Promise<{ full: boolean }>;
  /** Writes the joined video to the destination and deletes the local copy. */
  finish(destination: Writable): Promise<RecordingSpoolResult>;
}

/**
 * Keeps a growing recording on this machine while the sandbox is still recording it. The init
 * piece followed by its fragments is itself a playable MP4, so a sandbox lost mid-run still leaves
 * a video, without FFmpeg on this machine.
 */
export async function createRecordingSpool(options: {
  pieces: RecordingPieces;
  maxBytes: number;
  /** The space free on the disk that holds the spool. */
  freeBytes?: (directory: string) => Promise<number>;
}): Promise<RecordingSpool> {
  const { pieces, maxBytes, freeBytes = statfsFreeBytes } = options;
  await removeAbandonedSpools(tmpdir());
  const directory = await mkdtemp(path.join(tmpdir(), SPOOL_PREFIX));
  await writeFile(path.join(directory, SPOOL_OWNER_FILE), String(process.pid), { mode: 0o600 });
  const file = path.join(directory, "desktop.mp4");
  // Append mode, so writes after a truncate land at the new end and leave no hole.
  const handle = await open(file, "ax", 0o600).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  removeOnExit(directory);
  const startedAtMs = Date.now();
  let bytes = 0;
  let kept = 0;
  let init: Buffer | undefined;
  let full = false;
  let ended = false;
  let endMs = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const append = async (target: FileHandle, data: Buffer): Promise<void> => {
    try {
      await target.appendFile(data);
      bytes += data.length;
      heldBytes += data.length;
    } catch (error) {
      // A partly written piece would corrupt every piece after it.
      await target.truncate(bytes);
      throw error;
    }
  };

  const fits = (size: number): boolean => bytes + size <= maxBytes;

  // A piece takes its size twice: here now, and again when the video is written out. A disk whose
  // free space cannot be read records as it would have without this check.
  const diskHasRoom = async (size: number): Promise<boolean> => {
    const free = await freeBytes(directory).catch(() => Number.POSITIVE_INFINITY);
    return free - RESERVED_DISK_BYTES - size >= heldBytes + size;
  };

  const keepInit = async (): Promise<boolean> => {
    if (init) return true;
    const data = await pieces.read(INIT_NAME);
    if (data.length === 0) return false;
    if (!fits(data.length)) {
      full = true;
      return false;
    }
    await append(handle, data);
    init = data;
    return true;
  };

  const measureEnd = (added: readonly RecordingSegment[], lastData: Buffer): void => {
    const read = fragmentEndMs(init!, lastData);
    const believable =
      read !== undefined && read > 0 && read <= Date.now() - startedAtMs + CLOCK_ALLOWANCE_MS;
    // Playlist lengths run short when unchanged frames are dropped, so they are only a fallback.
    endMs = believable ? read : endMs + added.reduce((sum, segment) => sum + segment.durationMs, 0);
  };

  const keepSegments = async (
    segments: readonly RecordingSegment[],
  ): Promise<RecordingSegment[]> => {
    const newlyKept: RecordingSegment[] = [];
    let lastData: Buffer | undefined;
    for (const segment of segments.slice(kept)) {
      const data = await pieces.read(segment.name).catch(() => undefined);
      if (!data || data.length === 0) break;
      if (!fits(data.length) || !(await diskHasRoom(data.length))) {
        full = true;
        break;
      }
      const stored = await append(handle, data).then(
        () => true,
        () => false,
      );
      if (!stored) break;
      kept++;
      newlyKept.push(segment);
      lastData = data;
    }
    if (lastData) measureEnd(newlyKept, lastData);
    return newlyKept;
  };

  const pullOnce = async (): Promise<void> => {
    if (full) return;
    const playlist = parseRecordingPlaylist(await pieces.playlist());
    if (playlist.segments.length === 0 || !(await keepInit())) return;
    const newlyKept = await keepSegments(playlist.segments);
    if (newlyKept.length > 0) {
      await pieces.remove(newlyKept.map((segment) => segment.name)).catch(() => {});
    }
    ended = playlist.ended && !full && kept === playlist.segments.length;
  };

  const pull = (): Promise<{ full: boolean }> => {
    const run = queue.then(pullOnce).catch(() => {});
    queue = run;
    return run.then(() => ({ full }));
  };

  return {
    pull,
    async finish(destination) {
      await queue;
      try {
        await handle.close();
        if (kept === 0) throw new Error("Desktop recording produced no video.");
        await pipeline(createReadStream(file), destination);
        return { bytes, durationMs: Math.max(1, endMs), ended };
      } finally {
        await handle.close().catch(() => {});
        await rm(directory, { recursive: true, force: true });
        liveDirectories.delete(directory);
        heldBytes -= bytes;
      }
    },
  };
}
