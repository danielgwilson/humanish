// A contained file swapped for a FIFO after its checks and before it is opened is refused at once:
// opening a FIFO for reading without O_NONBLOCK waits for a writer that never comes.
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
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

describe("a contained file swapped for a FIFO", () => {
  it("is refused without waiting for a writer", async () => {
    const dir = await makeTestTempDir("humanish-contained-fifo-");
    const root = await prepareSelectedOutputDirectory(dir, ".");
    const file = path.join(root.physicalPath, "state.json");
    await writeFile(file, "{}");
    swap.target = file;

    try {
      const read = await Promise.race([
        readContainedRegularFile(root, "state.json", 1024),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
      ]);

      expect(read).toEqual({ status: "refused", reason: "changed", limit: 1024 });
    } finally {
      // Releases a reader the open left waiting, so a failing run still ends.
      try {
        closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // No reader is waiting.
      }
    }
  });
});
