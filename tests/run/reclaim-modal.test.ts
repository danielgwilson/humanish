import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sandboxIdDigest } from "../../src/evidence/redaction.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { reclaimPinnedRunSandboxes, reclaimRunSandboxes } from "../../src/run/reclaim.js";
import {
  beginSandboxCreate,
  sandboxOwnerTags,
  stopSandboxCreates,
} from "../../src/run/sandbox-creates.js";
import { appendSandboxOwner, appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import type { E2BAccount } from "../../src/substrates/e2b/connection.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";
import { runTerminal } from "../helpers/route-run.js";

// A run on Modal journals Modal receipts and a Modal owner line; reclaim acts on them through a
// Modal account and needs neither E2B nor its SDK.

async function modalRun(cwd: string, journal = true) {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "reclaim-modal",
    route: "terminal",
    mode: "dry-run",
    subject: {
      source: "terminal-product",
      product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
    },
    actor: { type: "codex-exec", mission: "Contract only." },
    caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 5 },
    execution: { target: "modal-terminal", runtimeAuth: "openai-env" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const run = await runTerminal({ cwd, config: parsed.config, dryRun: true, open: false });
  expect(run.ok).toBe(true);
  const runPaths = await resolveRunPath(cwd, "latest");
  if (runPaths === null) throw new Error("dry run left no run");
  if (!journal) return runPaths;
  await appendSandboxOwner(runPaths, sandboxOwnerTags(runPaths), "modal");
  await appendSandboxReceipt(runPaths, {
    at: "t1",
    laneId: "terminal",
    provider: "modal",
    sandboxId: "fake-sb-modal-1",
  });
  return runPaths;
}

/** A Modal account: the sandboxes named running until killed, and every list query it got. */
function modalAccount(running: string[]) {
  const killed: string[] = [];
  const queries: unknown[] = [];
  const account: E2BAccount = {
    async kill(sandboxId) {
      killed.push(sandboxId);
      return running.includes(sandboxId);
    },
    list(options) {
      queries.push(options?.query?.metadata);
      let read = false;
      return {
        get hasNext() {
          return !read;
        },
        async nextItems() {
          read = true;
          return [];
        },
      };
    },
  };
  return { account, killed, queries };
}

describe("humanish reclaim of a Modal run", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-modal-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("kills the receipt's sandbox on Modal and searches Modal by the run's tags, without E2B", async () => {
    const runPaths = await modalRun(cwd);
    const modal = modalAccount(["fake-sb-modal-1"]);
    const result = await reclaimRunSandboxes(cwd, "latest", {
      env: { MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test" },
      loadModule: async () => {
        throw new Error("Cannot find package '@e2b/desktop'");
      },
      loadModalAccount: async () => modal.account,
    });
    expect(modal.killed).toEqual(["fake-sb-modal-1"]);
    expect(modal.queries).toEqual([sandboxOwnerTags(runPaths)]);
    expect(result).toMatchObject({ ok: true, state: "clean", receiptCount: 1 });
    expect(result.tagSearch).toEqual({ status: "done", found: 0 });
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        sandboxIdDigest: sandboxIdDigest("fake-sb-modal-1"),
        source: "receipt",
        state: "killed",
      }),
    ]);
  });

  it("the signal handler kills a Modal create whose receipt and owner line never landed", async () => {
    const runPaths = await modalRun(cwd, false);
    const ticket = beginSandboxCreate(runPaths, "terminal", "modal");
    ticket.created("fake-sb-modal-2");
    ticket.settled();
    const modal = modalAccount(["fake-sb-modal-2"]);
    const result = await reclaimPinnedRunSandboxes(cwd, runPaths, {
      env: { MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test" },
      creates: stopSandboxCreates(runPaths),
      loadModule: async () => {
        throw new Error("Cannot find package '@e2b/desktop'");
      },
      loadModalAccount: async () => modal.account,
    });
    expect(modal.killed).toEqual(["fake-sb-modal-2"]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ source: "create", state: "killed" }),
    ]);
  });

  it("reaches Modal for a create whose id has not arrived when the stop comes", async () => {
    const runPaths = await modalRun(cwd, false);
    const ticket = beginSandboxCreate(runPaths, "terminal", "modal");
    const creates = stopSandboxCreates(runPaths);
    const modal = modalAccount(["fake-sb-modal-3"]);
    const reclaim = reclaimPinnedRunSandboxes(cwd, runPaths, {
      env: {},
      creates,
      loadModule: async () => {
        // The create reports its id while reclaim is still setting up.
        ticket.created("fake-sb-modal-3");
        ticket.settled();
        throw new Error("Cannot find package '@e2b/desktop'");
      },
      loadModalAccount: async () => modal.account,
    });
    await reclaim;
    expect(modal.killed).toEqual(["fake-sb-modal-3"]);
  });

  it("stops before killing anything when the Modal account cannot be reached", async () => {
    await modalRun(cwd);
    const result = await reclaimRunSandboxes(cwd, "latest", {
      env: {},
      loadModalAccount: async () => {
        throw new Error("No Modal credentials: set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      receiptCount: 1,
      error: {
        code: "HUMANISH_RECLAIM_MODULE_UNAVAILABLE",
        message: expect.stringContaining("Cannot reach Modal"),
      },
    });
  });
});
