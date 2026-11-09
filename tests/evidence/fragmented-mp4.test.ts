import { describe, expect, it } from "vitest";
import { fragmentEndMs } from "../../src/evidence/fragmented-mp4.js";
import {
  AUDIO_INIT,
  AUDIO_LAST,
  VIDEO_INIT,
  VIDEO_LAST,
} from "../helpers/fragmented-mp4-fixtures.js";

describe("fragmented MP4 end time", () => {
  it("reads the last video frame of a screen-only fragment", () => {
    expect(fragmentEndMs(VIDEO_INIT, VIDEO_LAST)).toBe(22_001);
  });

  it("reads the video track, not the audio track, of a recording with sound", () => {
    expect(fragmentEndMs(AUDIO_INIT, AUDIO_LAST)).toBe(176_734);
  });

  it("has no answer for bytes that are not a fragment of this recording", () => {
    expect(fragmentEndMs(VIDEO_INIT, Buffer.from("not a fragment"))).toBeUndefined();
    expect(fragmentEndMs(Buffer.from("not an init piece"), VIDEO_LAST)).toBeUndefined();
  });
});
