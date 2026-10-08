// A run file swapped for a FIFO after verify checks it and before verify opens it: opening a FIFO
// for reading without O_NONBLOCK waits for a writer that never comes.
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { verifyRun } from "../../src/verify/verify.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";
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

describe("a run file swapped for a FIFO", () => {
  it("ends verify without waiting for a writer and never grades the run", async () => {
    const cwd = await makeTestTempDir("humanish-verify-fifo-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    const file = path.join(await realpath(runDir), "notes.txt");
    await writeFile(file, "Plain text.\n");
    swap.target = file;

    try {
      const outcome = await Promise.race([
        verifyRun(cwd, runId).then(
          (verified) => verified.shareSafety.status,
          () => "refused",
        ),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
      ]);

      // The scan reads the FIFO as unscanned; the storage check after the scan refuses the run.
      expect(outcome).toBe("refused");
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
