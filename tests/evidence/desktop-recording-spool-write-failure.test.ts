import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRecordingSpool } from "../../src/evidence/desktop-recording-spool.js";

const disk = vi.hoisted(() => ({ failNextWrite: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const appendFile = handle.appendFile.bind(handle);
      handle.appendFile = (async (data: Buffer) => {
        if (!disk.failNextWrite) return appendFile(data);
        disk.failNextWrite = false;
        await appendFile(data.subarray(0, 3));
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }) as typeof handle.appendFile;
      return handle;
    },
  };
});

const LIST = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000000,
seg000000.m4s
#EXTINF:6.000000,
seg000001.m4s
`;

describe("a recording spool whose disk write fails partway through a segment", () => {
  it("drops the partial bytes and takes that segment again on the next pull", async () => {
    const removed: string[] = [];
    let failed = false;
    const spool = await createRecordingSpool({
      pieces: {
        playlist: async () => LIST,
        read: async (name) => {
          if (name === "seg000001.m4s" && !failed) {
            failed = true;
            disk.failNextWrite = true;
          }
          return Buffer.from(`[${name}]`);
        },
        remove: async (names) => {
          removed.push(...names);
        },
      },
      maxBytes: 1000,
      freeBytes: async () => 8 * 1024 ** 3,
    });
    await spool.pull();
    expect(removed).toEqual(["seg000000.m4s"]);
    await spool.pull();
    expect(removed).toEqual(["seg000000.m4s", "seg000001.m4s"]);
    const chunks: Buffer[] = [];
    await spool.finish(
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    expect(Buffer.concat(chunks).toString()).toBe("[init.mp4][seg000000.m4s][seg000001.m4s]");
  });
});
