import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createRecordingSpool,
  parseRecordingPlaylist,
  type RecordingPieces,
} from "../../src/evidence/desktop-recording-spool.js";
import { VIDEO_INIT, VIDEO_LAST } from "../helpers/fragmented-mp4-fixtures.js";

// Captured from FFmpeg 4.4's hls muxer on a hosted desktop.
const ENDED = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000036,
seg000000.m4s
#EXTINF:0.466669,
seg000001.m4s
#EXT-X-ENDLIST
`;

describe("recording playlist", () => {
  it("lists finished segments in order with their lengths", () => {
    expect(parseRecordingPlaylist(ENDED)).toEqual({
      segments: [
        { name: "seg000000.m4s", durationMs: 6000 },
        { name: "seg000001.m4s", durationMs: 467 },
      ],
      ended: true,
    });
  });

  it("reports a recording that is still being written as not ended", () => {
    expect(parseRecordingPlaylist(ENDED.replace("#EXT-X-ENDLIST\n", "")).ended).toBe(false);
  });

  it("has no segments before the recorder has finished one", () => {
    expect(parseRecordingPlaylist("#EXTM3U\n#EXT-X-VERSION:7\n")).toEqual({
      segments: [],
      ended: false,
    });
  });

  it("ignores a final segment line that is still being written", () => {
    const partial = `${ENDED.replace("#EXT-X-ENDLIST\n", "")}#EXTINF:5.0,\n`;
    expect(parseRecordingPlaylist(partial).segments.map((segment) => segment.name)).toEqual([
      "seg000000.m4s",
      "seg000001.m4s",
    ]);
  });

  it("refuses a segment name that the recorder could not have written", () => {
    expect(() => parseRecordingPlaylist("#EXTM3U\n#EXTINF:1.0,\n../../etc/passwd\n")).toThrow();
  });
});

function playlist(lengths: readonly number[], ended = false): string {
  const lines = ["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"'];
  lengths.forEach((seconds, index) => {
    lines.push(`#EXTINF:${seconds.toFixed(6)},`, `seg${String(index).padStart(6, "0")}.m4s`);
  });
  if (ended) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

function sink(): { destination: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString(),
  };
}

function pieces(overrides: Partial<RecordingPieces> & { list: string }): RecordingPieces {
  const { list, ...rest } = overrides;
  return {
    playlist: async () => list,
    read: async (name) => Buffer.from(`[${name}]`),
    remove: async () => {},
    ...rest,
  };
}

describe("recording spool", () => {
  it("joins the init piece and each segment once, in order, across pulls", async () => {
    let list = playlist([6]);
    const spool = await createRecordingSpool({
      pieces: { ...pieces({ list }), playlist: async () => list },
      maxBytes: 1000,
    });
    await spool.pull();
    list = playlist([6, 4], true);
    await spool.pull();
    await spool.pull();
    const out = sink();
    const result = await spool.finish(out.destination);
    expect(out.text()).toBe("[init.mp4][seg000000.m4s][seg000001.m4s]");
    expect(result).toEqual({ bytes: 40, durationMs: 10_000, ended: true });
  });

  it("ends the video at the last frame the recorder wrote", async () => {
    const spool = await createRecordingSpool({
      pieces: pieces({
        list: playlist([6, 0.5], true),
        read: async (name) =>
          name === "init.mp4"
            ? VIDEO_INIT
            : name === "seg000001.m4s"
              ? VIDEO_LAST
              : Buffer.from("x"),
      }),
      maxBytes: 100_000,
    });
    await spool.pull();
    expect((await spool.finish(sink().destination)).durationMs).toBe(22_001);
  });

  it("estimates the end from segment lengths when a fragment cannot be read", async () => {
    const spool = await createRecordingSpool({
      pieces: pieces({ list: playlist([6, 0.5], true) }),
      maxBytes: 1000,
    });
    await spool.pull();
    expect((await spool.finish(sink().destination)).durationMs).toBe(6500);
  });

  it("retries a failed segment next pull without skipping past it", async () => {
    let failures = 1;
    const spool = await createRecordingSpool({
      pieces: pieces({
        list: playlist([6, 6], true),
        read: async (name) => {
          if (name === "seg000000.m4s" && failures-- > 0) throw new Error("transient");
          return Buffer.from(`[${name}]`);
        },
      }),
      maxBytes: 1000,
    });
    await spool.pull();
    await spool.pull();
    const out = sink();
    await spool.finish(out.destination);
    expect(out.text()).toBe("[init.mp4][seg000000.m4s][seg000001.m4s]");
  });

  it("keeps what it collected when the sandbox is gone at the end", async () => {
    let alive = true;
    const base = pieces({ list: playlist([6]) });
    const spool = await createRecordingSpool({
      pieces: {
        ...base,
        playlist: async () => {
          if (!alive) throw new Error("sandbox gone");
          return playlist([6]);
        },
      },
      maxBytes: 1000,
    });
    await spool.pull();
    alive = false;
    await spool.pull();
    const out = sink();
    const result = await spool.finish(out.destination);
    expect(out.text()).toBe("[init.mp4][seg000000.m4s]");
    expect(result.ended).toBe(false);
    expect(result.durationMs).toBe(6000);
  });

  it("stops at the byte budget and never ends a video it cut short", async () => {
    const spool = await createRecordingSpool({
      pieces: pieces({ list: playlist([6, 6, 6], true) }),
      maxBytes: 26,
    });
    expect(await spool.pull()).toEqual({ full: true });
    const out = sink();
    const result = await spool.finish(out.destination);
    expect(out.text()).toBe("[init.mp4][seg000000.m4s]");
    expect(result).toMatchObject({ bytes: 25, ended: false });
  });

  it("removes a segment from the sandbox only after it is kept", async () => {
    const remove = vi.fn(async () => {});
    const spool = await createRecordingSpool({
      pieces: pieces({
        list: playlist([6, 6]),
        remove,
        read: async (name) => {
          if (name === "seg000001.m4s") throw new Error("transient");
          return Buffer.from(`[${name}]`);
        },
      }),
      maxBytes: 1000,
    });
    await spool.pull();
    expect(remove.mock.calls).toEqual([[["seg000000.m4s"]]]);
    await spool.finish(sink().destination);
  });

  it("does not interleave a pull with one already running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async (name: string) => {
      if (name === "init.mp4") await gate;
      return Buffer.from(`[${name}]`);
    });
    const spool = await createRecordingSpool({
      pieces: pieces({ list: playlist([6], true), read }),
      maxBytes: 1000,
    });
    const first = spool.pull();
    const second = spool.pull();
    release();
    await Promise.all([first, second]);
    expect(read.mock.calls.map(([name]) => name)).toEqual(["init.mp4", "seg000000.m4s"]);
    await spool.finish(sink().destination);
  });

  it("fails when no segment was ever collected", async () => {
    const spool = await createRecordingSpool({
      pieces: pieces({ list: playlist([]) }),
      maxBytes: 1000,
    });
    await spool.pull();
    await expect(spool.finish(sink().destination)).rejects.toThrow();
  });
});
