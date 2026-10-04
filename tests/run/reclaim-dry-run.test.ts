// `humanish reclaim` on a dry run. run.json and status.json record the run's mode, and a dry run
// creates no sandboxes, so reclaim reports it clean without loading the E2B SDK. A record that
// says live, or a journal or reclaim receipt that shows a create ran, sends it down the live path.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { RECLAIM_RECEIPT_ARTIFACT, reclaimRunSandboxes } from "../../src/run/reclaim.js";
import { sandboxOwnerTags } from "../../src/run/sandbox-creates.js";
import { appendSandboxOwner } from "../../src/run/sandbox-receipts.js";

const RUN = "reclaim-dry-run";

describe("humanish reclaim on a dry run", () => {
  let cwd: string;
  let runRoot: string;
  const loadModule = vi.fn(async () => {
    throw new Error("the E2B SDK was loaded");
  });
  beforeEach(async () => {
    loadModule.mockClear();
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-dry-run-"));
    expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
    runRoot = path.join(cwd, ".humanish", "runs", RUN);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const editJson = async (file: string, edit: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(await readFile(path.join(runRoot, file), "utf8")) as Record<
      string,
      unknown
    >;
    edit(value);
    await writeFile(path.join(runRoot, file), JSON.stringify(value));
  };

  it.each([false, true])(
    "reports it clean for the dry run and loads no E2B SDK (check %s)",
    async (check) => {
      // Both records say dry-run.
      for (const file of ["run.json", "status.json"])
        expect(JSON.parse(await readFile(path.join(runRoot, file), "utf8"))).toMatchObject({
          mode: "dry-run",
        });
      const result = await reclaimRunSandboxes(cwd, RUN, { loadModule, check });
      expect(result).toMatchObject({
        ok: true,
        state: "clean",
        reason: "dry-run",
        mode: check ? "check" : "kill",
        receiptCount: 0,
        outcomes: [],
        tagSearch: { status: "not-run", found: 0 },
      });
      expect(result.error).toBeUndefined();
      expect(loadModule).not.toHaveBeenCalled();
      await expect(readFile(path.join(runRoot, RECLAIM_RECEIPT_ARTIFACT))).rejects.toThrow(
        "ENOENT",
      );
    },
  );

  it.each([
    ["run.json says live", () => editJson("run.json", (bundle) => void (bundle.mode = "live"))],
    [
      "status.json says live",
      () => editJson("status.json", (status) => void (status.mode = "live")),
    ],
    [
      "neither record can be read",
      async () => {
        await writeFile(path.join(runRoot, "run.json"), "{");
        await rm(path.join(runRoot, "status.json"));
      },
    ],
    [
      "its journal records owner tags",
      async () => {
        const paths = await resolveRunPath(cwd, RUN);
        await appendSandboxOwner(paths!, sandboxOwnerTags(paths!));
      },
    ],
    [
      "an earlier reclaim names a sandbox",
      () =>
        writeFile(
          path.join(runRoot, RECLAIM_RECEIPT_ARTIFACT),
          JSON.stringify({ runId: RUN, outcomes: [{ state: "pending" }] }),
        ),
    ],
  ])("reclaims it as a live run when %s", async (_case, change) => {
    await change();
    const result = await reclaimRunSandboxes(cwd, RUN, { loadModule });
    expect(loadModule).toHaveBeenCalledOnce();
    expect(result.reason).toBeUndefined();
    expect(result.state).not.toBe("clean");
  });

  it.each([
    ["reclaim", ["reclaim"]],
    ["cleanup", ["cleanup"]],
  ])("%s exits 0 for a dry run", async (_command, args) => {
    let out = "";
    let exitCode: number | undefined;
    const program = createProgram({
      writeOut: (text) => {
        out += text;
      },
      writeErr: () => undefined,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    await program.parseAsync(["node", "humanish", ...args, "--run", RUN, "--cwd", cwd, "--json"], {
      from: "node",
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, state: "clean", reason: "dry-run" });
  });
});
