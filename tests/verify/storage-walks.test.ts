// The storage check refuses a run folder that holds a link or a special file anywhere under it, so
// it lists and lstats every entry. A run lists one entry per screenshot, about 70,000 for 24
// participants working 8 hours. These pin how often verify walks the folder and that a walk
// overlaps its calls.
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { validatePreparedRunArtifactPaths } from "../../src/run/paths.js";
import { verifyRun } from "../../src/verify/verify.js";

const watch = vi.hoisted(() => ({ runRoot: "", listings: 0, inFlight: 0, most: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // The storage check lists a folder with options; the public-safety scan lists it without.
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const [directory, options] = args;
      if (options !== undefined && String(directory) === watch.runRoot) watch.listings += 1;
      return actual.readdir(...args);
    }) as typeof actual.readdir,
    // Each lstat under many/ takes at least 1 ms, so calls a walk overlaps are in flight together.
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      if (watch.runRoot === "" || !String(args[0]).startsWith(`${watch.runRoot}/many/`))
        return actual.lstat(...args);
      watch.inFlight += 1;
      watch.most = Math.max(watch.most, watch.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await actual.lstat(...args);
      } finally {
        watch.inFlight -= 1;
      }
    }) as typeof actual.lstat,
  };
});

const runId = "storage-walks";
const FILES = 200;

describe("the run storage check", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-storage-walks-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId });
    const runRoot = await realpath(path.join(cwd, ".humanish", "runs", runId));
    await mkdir(path.join(runRoot, "many"));
    for (let index = 0; index < FILES; index += 1)
      await writeFile(path.join(runRoot, "many", `note-${index}.txt`), "Plain text.\n");
    Object.assign(watch, { runRoot, listings: 0, inFlight: 0, most: 0 });
  });
  afterEach(async () => {
    watch.runRoot = "";
    await rm(cwd, { recursive: true, force: true });
  });

  it("walks the run folder twice in one verify: when it binds the run and after the scan", async () => {
    expect((await verifyRun(cwd, runId)).ok).toBe(true);
    expect(watch.listings).toBe(2);
  });

  it("checks a folder's entries several at a time, never all at once", async () => {
    const prepared = (await resolveRunPath(cwd, runId))!;
    watch.most = 0;
    await validatePreparedRunArtifactPaths(prepared);
    expect(watch.most).toBeGreaterThan(1);
    expect(watch.most).toBeLessThan(FILES);
  });
});
