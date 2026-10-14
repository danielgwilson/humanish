// The storage check refuses a run folder that holds a link or a special file anywhere under it, so
// it lists and lstats every entry. A run lists one entry per screenshot, about 70,000 for 24
// participants working 8 hours. These pin when the check looks at the folder and that a walk
// overlaps its calls.
import { cp, link, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { prepareRunArtifactPaths, validatePreparedRunArtifactPaths } from "../../src/run/paths.js";
import { verifyRun } from "../../src/verify/verify.js";

type Moment = "runRootRealpath" | "runJsonOpen" | "scanListing";

const watch = vi.hoisted(() => ({
  runRoot: "",
  inFlight: 0,
  most: 0,
  // A change to the folder that runs once, just before the named call returns.
  changes: {} as Partial<Record<Moment, () => Promise<void>>>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const change = async (moment: Moment) => {
    const run = watch.changes[moment];
    delete watch.changes[moment];
    await run?.();
  };
  return {
    ...actual,
    // Binding a run captures its folder's identity through realpath.
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      if (watch.runRoot !== "" && String(args[0]) === watch.runRoot)
        await change("runRootRealpath");
      return result;
    }) as typeof actual.realpath,
    // verify's first read after binding opens run.json.
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (watch.runRoot !== "" && String(args[0]) === `${watch.runRoot}/run.json`)
        await change("runJsonOpen");
      return handle;
    }) as typeof actual.open,
    // The storage check lists a folder with options; the public-safety scan lists it without.
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const [directory, options] = args;
      if (watch.runRoot !== "" && options === undefined && String(directory) === watch.runRoot)
        await change("scanListing");
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
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "humanish-storage-walks-")));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId });
    const runRoot = path.join(cwd, ".humanish", "runs", runId);
    await mkdir(path.join(runRoot, "many"));
    for (let index = 0; index < FILES; index += 1)
      await writeFile(path.join(runRoot, "many", `note-${index}.txt`), "Plain text.\n");
    Object.assign(watch, { runRoot, inFlight: 0, most: 0, changes: {} });
  });
  afterEach(async () => {
    watch.runRoot = "";
    await rm(cwd, { recursive: true, force: true });
  });

  // A second name outside the run lets another writer change the file's bytes. The check looks for
  // it before binding captures the folder's identity, so a name removed during the capture still
  // refuses the run.
  async function secondNameGoneWhileBinding(): Promise<void> {
    const secondName = path.join(cwd, "second-name.txt");
    await link(path.join(watch.runRoot, "many", "note-0.txt"), secondName);
    watch.changes.runRootRealpath = () => unlink(secondName);
  }

  it("blocks a run whose file has a second name when verify binds it, even if the name goes", async () => {
    await secondNameGoneWhileBinding();
    const result = await verifyRun(cwd, runId);
    expect(result.shareSafety.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "run storage containment", ok: false }),
    );
  });

  it("refuses to prepare a run folder whose file has a second name, even if the name goes", async () => {
    await secondNameGoneWhileBinding();
    await expect(prepareRunArtifactPaths(cwd, runId)).rejects.toThrow(
      "humanish run leaves must be single-link regular files",
    );
  });

  // verify reads run.json, the reviews and the receipts between binding and the scan. The check
  // before the scan sees a second name made during those reads, though the scan itself would not.
  it("refuses a run whose file gains a second name after binding and loses it before the scan", async () => {
    const secondName = path.join(cwd, "second-name.txt");
    watch.changes.runJsonOpen = () =>
      link(path.join(watch.runRoot, "many", "note-0.txt"), secondName);
    watch.changes.scanListing = () => unlink(secondName);
    await expect(verifyRun(cwd, runId)).rejects.toThrow(
      "humanish run leaves must be single-link regular files",
    );
  });

  it("checks a folder's entries several at a time, never all at once", async () => {
    const prepared = (await resolveRunPath(cwd, runId))!;
    watch.most = 0;
    await validatePreparedRunArtifactPaths(prepared);
    expect(watch.most).toBeGreaterThan(1);
    expect(watch.most).toBeLessThan(FILES);
  });
});
