import { createReadStream } from "node:fs";
import { rmSync } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
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
}): Promise<RecordingSpool> {
  const { pieces, maxBytes } = options;
  const directory = await mkdtemp(path.join(tmpdir(), "humanish-recording-"));
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
    } catch (error) {
      // A partly written piece would corrupt every piece after it.
      await target.truncate(bytes);
      throw error;
    }
  };

  const fits = (size: number): boolean => bytes + size <= maxBytes;

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
      if (!fits(data.length)) {
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
      }
    },
  };
}
