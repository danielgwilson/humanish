// Bundle export reads each source file within what is left of --max-bytes, and refuses a file that
// changes as it is opened: one swapped for a FIFO, or one that grows.
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { cp, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { exportRun } from "../../src/feedback/export.js";
import { bytesReadDuring } from "../helpers/bytes-read.js";
import { runSyntheticLive } from "../helpers/synthetic-live-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "synthetic-export-reads";
const OPTIONS = { format: "bundle" as const, redactScreenshots: true, out: "shared" };
const GROWTH = 8 * 1024 * 1024;

// What happens to `target` just before it is next opened.
const swap = vi.hoisted(() => ({ target: "", change: "fifo" as "fifo" | "grow" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [file] = args;
      if (swap.target !== "" && file === swap.target) {
        swap.target = "";
        if (swap.change === "grow") {
          await actual.appendFile(file, Buffer.alloc(GROWTH, " "));
        } else {
          await actual.unlink(file);
          execFileSync("sh", ["-c", 'mkfifo "$1"', "sh", file]);
        }
      }
      return actual.open(...args);
    },
  };
});

async function exportableRun(): Promise<{ cwd: string; runDir: string }> {
  const cwd = await makeTestTempDir("humanish-export-reads-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runSyntheticLive({ cwd, dryRun: true, runId: RUN });
  return { cwd, runDir: await realpath(path.join(cwd, ".humanish", "runs", RUN)) };
}

describe("bundle export source reads", () => {
  it("refuses a source file swapped for a FIFO without waiting for a writer", async () => {
    const { cwd, runDir } = await exportableRun();
    const file = path.join(runDir, "notes.txt");
    await writeFile(file, "Plain text.\n");
    Object.assign(swap, { target: file, change: "fifo" });

    try {
      const result = await Promise.race([
        exportRun(cwd, RUN, OPTIONS),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
      ]);

      expect(result).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_EXPORT_BUNDLE_REFUSED" },
      });
      await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      // Releases a reader the open left waiting, so a failing run still ends.
      try {
        closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // No reader is waiting.
      }
    }
  });

  it("refuses a source file that grows as it is opened without reading the growth", async () => {
    const { cwd, runDir } = await exportableRun();
    const file = path.join(runDir, "notes.txt");
    await writeFile(file, "Plain text.\n");
    Object.assign(swap, { target: file, change: "grow" });

    let result!: Awaited<ReturnType<typeof exportRun>>;
    const bytes = await bytesReadDuring(async () => {
      result = await exportRun(cwd, RUN, OPTIONS);
    });

    expect(result).toMatchObject({ ok: false, error: { code: "HUMANISH_EXPORT_BUNDLE_REFUSED" } });
    expect(bytes).toBeLessThan(GROWTH);
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
