// A contained file swapped for a FIFO after its checks and before it is opened for an append is
// refused at once: opening a FIFO for writing without O_NONBLOCK waits for a reader that never comes.
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  appendContainedOutputFile,
  prepareSelectedOutputDirectory,
} from "../../src/run/contained-output.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const swap = vi.hoisted(() => ({ target: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [file] = args;
      if (swap.target !== "" && file === swap.target) {
        swap.target = "";
        await actual.unlink(file);
        execFileSync("sh", ["-c", 'mkfifo "$1"', "sh", file]);
      }
      return actual.open(...args);
    },
  };
});

describe("a contained file swapped for a FIFO before an append", () => {
  it("is refused without waiting for a reader", async () => {
    const dir = await makeTestTempDir("humanish-contained-append-fifo-");
    const root = await prepareSelectedOutputDirectory(dir, ".");
    const file = path.join(root.physicalPath, "1.1.ndjson");
    await writeFile(file, "{}\n");
    swap.target = file;

    try {
      const appended = await Promise.race([
        appendContainedOutputFile(root, "1.1.ndjson", Buffer.from("{}\n"), 3).then(
          () => "appended",
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
      ]);

      // POSIX open(2): a nonblocking write-only open of a FIFO no process reads fails at once.
      expect(appended).toMatchObject({ code: "ENXIO" });
    } finally {
      // Releases a writer the open left waiting, so a failing run still ends.
      try {
        closeSync(openSync(file, constants.O_RDONLY | constants.O_NONBLOCK));
      } catch {
        // No writer is waiting.
      }
    }
  });
});
