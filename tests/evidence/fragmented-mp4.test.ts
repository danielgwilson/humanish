import { describe, expect, it } from "vitest";
import { fragmentEndMs } from "../../src/evidence/fragmented-mp4.js";
import {
  AUDIO_INIT,
  AUDIO_LAST,
  MODAL_INIT,
  MODAL_LAST,
  VIDEO_INIT,
  VIDEO_LAST,
} from "../helpers/fragmented-mp4-fixtures.js";

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const i32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
const u64 = (value: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const box = (type: string, ...parts: readonly Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
};
const fullBox = (type: string, version: number, flags: number, ...parts: readonly Buffer[]) =>
  box(type, u32(version * 2 ** 24 + flags), ...parts);
const moof = (...parts: readonly Buffer[]): Buffer => box("moof", box("traf", ...parts));
/** One video track, id 1, in ticks of 1 ms, with samples 1 tick long by default. */
const init = (): Buffer =>
  box(
    "moov",
    box(
      "trak",
      fullBox("tkhd", 0, 0, u32(0), u32(0), u32(1)),
      box(
        "mdia",
        fullBox("mdhd", 0, 0, u32(0), u32(0), u32(1000)),
        fullBox("hdlr", 0, 0, u32(0), Buffer.from("vide", "latin1")),
      ),
    ),
    box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(1), u32(0), u32(0))),
  );

describe("fragmented MP4 end time", () => {
  it("reads the last video frame of a screen-only fragment", () => {
    expect(fragmentEndMs(VIDEO_INIT, VIDEO_LAST)).toBe(22_001);
  });

  it("reads the video track, not the audio track, of a recording with sound", () => {
    expect(fragmentEndMs(AUDIO_INIT, AUDIO_LAST)).toBe(176_734);
  });

  it("reads FFmpeg 7.1's fragments", () => {
    expect(fragmentEndMs(MODAL_INIT, MODAL_LAST)).toBe(171_401);
  });

  it("reads wide timestamps, optional header fields and negative frame offsets", () => {
    const fragment = moof(
      fullBox("tfhd", 0, 0x1 | 0x2 | 0x8, u32(1), u64(0), u32(1), u32(200)),
      fullBox("tfdt", 1, 0, u64(1000)),
      fullBox("trun", 1, 0x100 | 0x800, u32(2), u32(100), i32(-50), u32(100), i32(300)),
    );
    // Frames decode at 1000 and 1100 ticks of 1 ms, and show at 950 and 1400.
    expect(fragmentEndMs(init(), fragment)).toBe(1400);
  });

  it("falls back to the fragment's default frame length", () => {
    const fragment = moof(
      fullBox("tfhd", 0, 0x8, u32(1), u32(200)),
      fullBox("tfdt", 0, 0, u32(1000)),
      fullBox("trun", 0, 0x800, u32(2), u32(0), u32(0)),
    );
    expect(fragmentEndMs(init(), fragment)).toBe(1200);
  });

  it("answers at once for a huge sample count with nothing to walk", () => {
    const fragment = moof(
      fullBox("tfhd", 0, 0, u32(1)),
      fullBox("tfdt", 0, 0, u32(0)),
      fullBox("trun", 0, 0, u32(1_000_000_000)),
    );
    const started = performance.now();
    expect(fragmentEndMs(init(), fragment)).toBe(999_999_999);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("refuses a sample count larger than its box can hold", () => {
    const fragment = moof(
      fullBox("tfhd", 0, 0, u32(1)),
      fullBox("tfdt", 0, 0, u32(0)),
      fullBox("trun", 0, 0x100, u32(1_000_000_000), u32(1)),
    );
    expect(fragmentEndMs(init(), fragment)).toBeUndefined();
  });

  it("has no answer for bytes that are not a fragment of this recording", () => {
    expect(fragmentEndMs(VIDEO_INIT, Buffer.from("not a fragment"))).toBeUndefined();
    expect(fragmentEndMs(Buffer.from("not an init piece"), VIDEO_LAST)).toBeUndefined();
  });
});
