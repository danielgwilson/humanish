// Reads the few MP4 boxes that say when a recording's last frame falls. FFmpeg 4.4's ffprobe
// misreports the times of a fragment probed apart from its recording, and a lost sandbox cannot
// be asked at all, so the host reads the headers of the bytes it already holds.

interface Box {
  type: string;
  body: number;
  end: number;
}

function readBoxes(data: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = data.readUInt32BE(at);
    let body = at + 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) throw new RangeError("Malformed box.");
    boxes.push({ type: data.toString("latin1", at + 4, at + 8), body, end: at + size });
    at += size;
  }
  return boxes;
}

const children = (data: Buffer, parent: Box): Box[] => readBoxes(data, parent.body, parent.end);
const only = (boxes: readonly Box[], type: string): Box | undefined =>
  boxes.find((box) => box.type === type);

interface VideoTrack {
  id: number;
  timescale: number;
  defaultDuration: number;
}

/** A version 1 full box widens its two leading timestamps from 4 bytes to 8. */
const afterTimestamps = (data: Buffer, box: Box): number =>
  box.body + (data[box.body] === 1 ? 20 : 12);

function findVideoTrack(init: Buffer): VideoTrack | undefined {
  const moov = only(readBoxes(init, 0, init.length), "moov");
  if (!moov) return undefined;
  const boxes = children(init, moov);
  const mvex = only(boxes, "mvex");
  for (const trak of boxes.filter((box) => box.type === "trak")) {
    const parts = children(init, trak);
    const tkhd = only(parts, "tkhd");
    const mdia = only(parts, "mdia");
    if (!tkhd || !mdia) continue;
    const media = children(init, mdia);
    const mdhd = only(media, "mdhd");
    const hdlr = only(media, "hdlr");
    if (!mdhd || !hdlr || init.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide")
      continue;
    const id = init.readUInt32BE(afterTimestamps(init, tkhd));
    const trex = (mvex ? children(init, mvex) : []).find(
      (box) => box.type === "trex" && init.readUInt32BE(box.body + 4) === id,
    );
    return {
      id,
      timescale: init.readUInt32BE(afterTimestamps(init, mdhd)),
      defaultDuration: trex ? init.readUInt32BE(trex.body + 12) : 0,
    };
  }
  return undefined;
}

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_COMPOSITION = 0x800;

const flagsOf = (data: Buffer, box: Box): number => data.readUInt32BE(box.body) & 0xffffff;

function fragmentDefaultDuration(data: Buffer, tfhd: Box, fallback: number): number {
  const flags = flagsOf(data, tfhd);
  if ((flags & TFHD_DEFAULT_DURATION) === 0) return fallback;
  let at = tfhd.body + 8;
  if (flags & TFHD_BASE_DATA_OFFSET) at += 8;
  if (flags & TFHD_DESCRIPTION_INDEX) at += 4;
  return data.readUInt32BE(at);
}

/** Walks one run of samples: returns where decoding ends and the latest presentation time. */
function walkRun(
  data: Buffer,
  trun: Box,
  firstDecode: number,
  defaultDuration: number,
): { decode: number; latest: number | undefined } {
  const flags = flagsOf(data, trun);
  const signedOffsets = data[trun.body] === 1;
  const count = data.readUInt32BE(trun.body + 4);
  let at = trun.body + 8;
  if (flags & TRUN_DATA_OFFSET) at += 4;
  if (flags & TRUN_FIRST_FLAGS) at += 4;
  const width =
    (flags & TRUN_DURATION ? 4 : 0) +
    (flags & TRUN_SIZE ? 4 : 0) +
    (flags & TRUN_FLAGS ? 4 : 0) +
    (flags & TRUN_COMPOSITION ? 4 : 0);
  // These bytes come from a sandbox, so a count must fit the box that claims it.
  if (count * width > trun.end - at) throw new RangeError("Malformed sample run.");
  if (width === 0) {
    const last = count === 0 ? undefined : firstDecode + (count - 1) * defaultDuration;
    return { decode: firstDecode + count * defaultDuration, latest: last };
  }
  let decode = firstDecode;
  let latest: number | undefined;
  for (let sample = 0; sample < count; sample++) {
    let duration = defaultDuration;
    if (flags & TRUN_DURATION) {
      duration = data.readUInt32BE(at);
      at += 4;
    }
    if (flags & TRUN_SIZE) at += 4;
    if (flags & TRUN_FLAGS) at += 4;
    let offset = 0;
    if (flags & TRUN_COMPOSITION) {
      offset = signedOffsets ? data.readInt32BE(at) : data.readUInt32BE(at);
      at += 4;
    }
    latest = Math.max(latest ?? -Infinity, decode + offset);
    decode += duration;
  }
  return { decode, latest };
}

function latestInTrackFragment(data: Buffer, traf: Box, track: VideoTrack): number | undefined {
  const parts = children(data, traf);
  const tfhd = only(parts, "tfhd");
  const tfdt = only(parts, "tfdt");
  if (!tfhd || !tfdt || data.readUInt32BE(tfhd.body + 4) !== track.id) return undefined;
  const defaultDuration = fragmentDefaultDuration(data, tfhd, track.defaultDuration);
  let decode =
    data[tfdt.body] === 1
      ? Number(data.readBigUInt64BE(tfdt.body + 4))
      : data.readUInt32BE(tfdt.body + 4);
  let latest: number | undefined;
  for (const trun of parts.filter((box) => box.type === "trun")) {
    const run = walkRun(data, trun, decode, defaultDuration);
    decode = run.decode;
    if (run.latest !== undefined) latest = Math.max(latest ?? -Infinity, run.latest);
  }
  return latest;
}

/**
 * When the last video frame of a fragment is shown, in milliseconds on the recording's clock.
 * Undefined when the bytes are not a video fragment of that init piece.
 */
export function fragmentEndMs(init: Buffer, fragment: Buffer): number | undefined {
  try {
    const track = findVideoTrack(init);
    if (!track || track.timescale === 0) return undefined;
    let latest: number | undefined;
    for (const moof of readBoxes(fragment, 0, fragment.length).filter((box) => box.type === "moof"))
      for (const traf of children(fragment, moof).filter((box) => box.type === "traf")) {
        const found = latestInTrackFragment(fragment, traf, track);
        if (found !== undefined) latest = Math.max(latest ?? -Infinity, found);
      }
    return latest === undefined ? undefined : Math.round((latest * 1000) / track.timescale);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}
