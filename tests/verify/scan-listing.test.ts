// The public-safety scan lists every directory of a run. A directory it cannot list, and the
// entries past the most it lists, hold files it never read, so the run cannot grade share_ready.
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { verifyRun } from "../../src/verify/verify.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// The scan lists a directory with readdir(path); storage validation passes options. One listing of
// `target` by the scan fails as a transient permission error would.
const failing = vi.hoisted(() => ({ target: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const [directory, options] = args;
      if (failing.target !== "" && options === undefined && String(directory) === failing.target) {
        failing.target = "";
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      }
      return actual.readdir(...args);
    }) as typeof actual.readdir,
  };
});

function unscannedReason(verified: Awaited<ReturnType<typeof verifyRun>>): string | undefined {
  return verified.shareSafety.reasons.find((reason) => reason.code === "UNSCANNED_ARTIFACT")
    ?.message;
}

describe("the public-safety scan's directory listing", () => {
  it("names a directory it could not list as unscanned", async () => {
    const cwd = await makeTestTempDir("humanish-scan-listing-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    const extras = path.join(await realpath(runDir), "extras");
    await mkdir(extras);
    await writeFile(path.join(extras, "notes.txt"), "Plain text.\n");
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");
    failing.target = extras;

    const verified = await verifyRun(cwd, runId);

    expect(verified.shareSafety.status).toBe("local_only");
    expect(unscannedReason(verified)).toContain("extras/");
  });

  it("stops after 10,000 entries and names the stop as unscanned", async () => {
    const cwd = await makeTestTempDir("humanish-scan-entries-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    // Empty directories: the walk counts them without reading any file.
    const many = path.join(runDir, "many");
    await mkdir(many);
    for (let index = 0; index < 10_001; index += 1)
      await mkdir(path.join(many, String(index).padStart(5, "0")));

    const verified = await verifyRun(cwd, runId);

    expect(verified.shareSafety.status).toBe("local_only");
    expect(unscannedReason(verified)).toContain("10000 entries");
  }, 60_000);
});
