// `humanish reclaim` on a dry run. run.json and status.json record the run's mode, and a dry run
// creates no sandboxes, so reclaim reports it clean without loading the E2B SDK. A record that
// says live, or a journal or reclaim receipt that shows a create ran, sends it down the live path.
// A live run whose status.json records `sandboxes: none` is reported clean the same way.

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

const loadModule = vi.fn(async () => {
  throw new Error("the E2B SDK was loaded");
});

/** A dry run written into a fresh project before each test, and an editor for its JSON files. */
function useDryRun() {
  const dirs = { cwd: "", runRoot: "" };
  beforeEach(async () => {
    loadModule.mockClear();
    dirs.cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-dry-run-"));
    expect((await runDryRun({ cwd: dirs.cwd, dryRun: true, runId: RUN })).ok).toBe(true);
    dirs.runRoot = path.join(dirs.cwd, ".humanish", "runs", RUN);
  });
  afterEach(async () => {
    await rm(dirs.cwd, { recursive: true, force: true });
  });
  const editJson = async (file: string, edit: (value: Record<string, unknown>) => void) => {
    const filePath = path.join(dirs.runRoot, file);
    const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    edit(value);
    await writeFile(filePath, JSON.stringify(value));
  };
  return { dirs, editJson };
}

describe("humanish reclaim on a dry run", () => {
  const { dirs, editJson } = useDryRun();

  it.each([false, true])(
    "reports it clean for the dry run and loads no E2B SDK (check %s)",
    async (check) => {
      // Both records say dry-run.
      for (const file of ["run.json", "status.json"])
        expect(JSON.parse(await readFile(path.join(dirs.runRoot, file), "utf8"))).toMatchObject({
          mode: "dry-run",
        });
      const result = await reclaimRunSandboxes(dirs.cwd, RUN, { loadModule, check });
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
      await expect(readFile(path.join(dirs.runRoot, RECLAIM_RECEIPT_ARTIFACT))).rejects.toThrow(
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
        await writeFile(path.join(dirs.runRoot, "run.json"), "{");
        await rm(path.join(dirs.runRoot, "status.json"));
      },
    ],
    [
      "its journal records owner tags",
      async () => {
        const paths = await resolveRunPath(dirs.cwd, RUN);
        await appendSandboxOwner(paths!, sandboxOwnerTags(paths!));
      },
    ],
    [
      "an earlier reclaim names a sandbox",
      () =>
        writeFile(
          path.join(dirs.runRoot, RECLAIM_RECEIPT_ARTIFACT),
          JSON.stringify({ runId: RUN, outcomes: [{ state: "pending" }] }),
        ),
    ],
  ])("reclaims it as a live run when %s", async (_case, change) => {
    await change();
    const result = await reclaimRunSandboxes(dirs.cwd, RUN, { loadModule });
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
    await program.parseAsync(
      ["node", "humanish", ...args, "--run", RUN, "--cwd", dirs.cwd, "--json"],
      {
        from: "node",
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, state: "clean", reason: "dry-run" });
  });
});

describe("humanish reclaim on a live run whose status.json records that it created no sandbox", () => {
  const { dirs, editJson } = useDryRun();
  const markLive = async (sandboxes: unknown) => {
    await editJson("run.json", (bundle) => void (bundle.mode = "live"));
    await editJson("status.json", (status) => {
      status.mode = "live";
      if (sandboxes !== undefined) status.sandboxes = sandboxes;
    });
  };

  it.each([false, true])(
    "reports it clean with reason no-sandbox and loads no E2B SDK (check %s)",
    async (check) => {
      await markLive("none");
      const result = await reclaimRunSandboxes(dirs.cwd, RUN, { loadModule, check });
      expect(result).toMatchObject({
        ok: true,
        state: "clean",
        reason: "no-sandbox",
        receiptCount: 0,
        outcomes: [],
        tagSearch: { status: "not-run", found: 0 },
      });
      expect(loadModule).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["status.json records nothing about sandboxes", () => markLive(undefined)],
    ["status.json records another value", () => markLive("unknown")],
    [
      "status.json names another run",
      async () => {
        await markLive("none");
        await editJson("status.json", (status) => void (status.runId = "another-run"));
      },
    ],
    [
      "its journal records owner tags",
      async () => {
        await markLive("none");
        const paths = await resolveRunPath(dirs.cwd, RUN);
        await appendSandboxOwner(paths!, sandboxOwnerTags(paths!));
      },
    ],
    [
      "an earlier reclaim names a sandbox",
      async () => {
        await markLive("none");
        await writeFile(
          path.join(dirs.runRoot, RECLAIM_RECEIPT_ARTIFACT),
          JSON.stringify({ runId: RUN, outcomes: [{ state: "pending" }] }),
        );
      },
    ],
  ])("searches E2B and is not clean when %s", async (_case, change) => {
    await change();
    const result = await reclaimRunSandboxes(dirs.cwd, RUN, { loadModule, check: true });
    expect(loadModule).toHaveBeenCalledOnce();
    expect(result.reason).toBeUndefined();
    expect(result.state).not.toBe("clean");
  });

  it("reclaim --check exits 0 and prints the run as clean", async () => {
    await markLive("none");
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
    await program.parseAsync(
      ["node", "humanish", "reclaim", "--check", "--run", RUN, "--cwd", dirs.cwd],
      { from: "node" },
    );
    expect(exitCode).toBe(0);
    expect(out).toMatch(new RegExp(`^Reclaim check ${RUN}: clean\\.`));
  });
});
