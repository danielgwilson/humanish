import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Salvage tier: interrupted runs fail cheap. The run journals every created sandbox id to
// disk the moment create returns, and tags every sandbox with its owner tags; `humanish reclaim`
// kills by the recorded ids and by E2B's list of sandboxes carrying exactly those tags, and records
// what happened to each. These tests drive the real run-dir resolution chain (a $0 dry-run creates
// the managed dir + latest pointer) with a fake @e2b/desktop module, so the containment discipline
// is exercised, not mocked away.
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { parseStudy } from "../../src/study/config.js";
import { runTerminalProductStudy } from "../../src/routes/terminal/route.js";
import { resolveRunPath } from "../../src/run/locate.js";
import {
  appendSandboxOwner,
  appendSandboxReceipt,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "../../src/run/sandbox-receipts.js";
import { createProgram } from "../../src/cli/program.js";
import { runIdOf } from "../../src/run/paths.js";
import { RECLAIM_RECEIPT_ARTIFACT, reclaimRunSandboxes } from "../../src/run/reclaim.js";
import { sandboxOwnerTags } from "../../src/run/sandbox-creates.js";
import type { E2BDesktopModule, E2BListedSandbox } from "../../src/substrates/e2b/sdk.js";

function dryRunConfig(): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "reclaim-fixture",
    route: "terminal",
    mode: "dry-run",
    subject: {
      source: "terminal-product",
      product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
    },
    actor: { type: "codex-exec", mission: "Contract only." },
    caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 5 },
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

interface FakeE2B {
  /** What the list endpoint returns for any query, before reclaim's own tag check. */
  listed?: E2BListedSandbox[];
  listError?: Error;
  /** Every list query reclaim made. */
  queries?: unknown[];
  /** Holds every kill open until the test resolves it. */
  hold?: Promise<void>;
  /** getInfo answers for `--check`: running, or gone (SandboxNotFoundError). */
  info?: Record<string, "running" | "gone">;
}

/** A fake @e2b/desktop module: kill by id, a one-page tag list, and getInfo for checks. */
function fakeModule(
  behavior: Record<string, "ok" | "gone" | "not-found-throw" | "boom">,
  killedIds: string[],
  fake: FakeE2B = {},
): E2BDesktopModule {
  const notFound = (sandboxId: string) =>
    Object.assign(new Error(`sandbox ${sandboxId} is gone`), { name: "SandboxNotFoundError" });
  return {
    Sandbox: {
      async create() {
        throw new Error("reclaim never creates sandboxes");
      },
      async kill(sandboxId: string) {
        killedIds.push(sandboxId);
        await fake.hold;
        const mode = behavior[sandboxId] ?? "gone";
        if (mode === "ok") return true;
        if (mode === "gone") return false;
        if (mode === "not-found-throw") throw notFound(sandboxId);
        throw new Error("provider exploded");
      },
      async getInfo(sandboxId: string) {
        if (fake.info?.[sandboxId] === "running") return { sandboxId, state: "running" };
        throw notFound(sandboxId);
      },
      list(options: unknown) {
        fake.queries?.push(options);
        let read = false;
        return {
          get hasNext() {
            return !read;
          },
          async nextItems() {
            read = true;
            if (fake.listError) throw fake.listError;
            return fake.listed ?? [];
          },
        };
      },
    },
  } as unknown as E2BDesktopModule;
}

/**
 * A $0 terminal dry run in `cwd`, whose directory reclaim then reads. It records the run's owner
 * tags, as a run from this version does before its first create.
 */
async function dryRun(cwd: string) {
  const run = await runTerminalProductStudy({
    cwd,
    config: dryRunConfig(),
    dryRun: true,
    open: false,
  });
  expect(run.ok).toBe(true);
  const runPaths = await resolveRunPath(cwd, "latest");
  if (runPaths === null) throw new Error("dry run left no run");
  await appendSandboxOwner(runPaths, sandboxOwnerTags(runPaths));
  return runPaths;
}

describe("parseSandboxReceipts", () => {
  it("parseSandboxReceipts keeps valid lines and drops a torn final line", () => {
    const text = `${JSON.stringify({ at: "t", laneId: "lane-01", sandboxId: "fake-sb-1", timeoutMs: 5 })}\n{"laneId":"lane-02","sandbo`;
    expect(parseSandboxReceipts(text)).toEqual([
      { at: "t", laneId: "lane-01", provider: "e2b", sandboxId: "fake-sb-1", timeoutMs: 5 },
    ]);
  });

  it("parseSandboxReceipts keeps a recorded provider, including one it does not know", () => {
    const lines = [
      { at: "t1", laneId: "lane-01", provider: "e2b", sandboxId: "fake-sb-1" },
      { at: "t2", laneId: "lane-02", provider: "example-cloud", sandboxId: "fake-sb-2" },
      { at: "t3", laneId: "lane-03", provider: 7, sandboxId: "fake-sb-3" },
    ];
    expect(parseSandboxReceipts(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual([
      { at: "t1", laneId: "lane-01", provider: "e2b", sandboxId: "fake-sb-1" },
      { at: "t2", laneId: "lane-02", provider: "example-cloud", sandboxId: "fake-sb-2" },
    ]);
  });
});

describe("sandbox receipts + humanish reclaim", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reports a receipt from an unknown provider without killing anything on E2B", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    await writeFile(
      path.join(runPaths!.absoluteRunRoot, SANDBOX_RECEIPTS_ARTIFACT),
      `${JSON.stringify({ at: "t1", laneId: "lane-01", provider: "example-cloud", sandboxId: "fake-sb-elsewhere" })}\n`,
    );
    const killedIds: string[] = [];

    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, killedIds),
    });

    expect(killedIds).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("unconfirmed");
    expect(result.outcomes).toEqual([
      {
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest("fake-sb-elsewhere"),
        laneId: "lane-01",
        source: "receipt",
        state: "unsupported-provider",
        detail: expect.stringContaining('"example-cloud"'),
      },
    ]);
  });

  it("kills an old receipt with no provider and a new e2b one through the same E2B path", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    await appendSandboxReceipt(runPaths!, {
      at: "t1",
      laneId: "lane-01",
      sandboxId: "fake-sb-old",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t2",
      laneId: "lane-02",
      provider: "e2b",
      sandboxId: "fake-sb-new",
    });
    const killedIds: string[] = [];

    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({ "fake-sb-old": "ok", "fake-sb-new": "ok" }, killedIds),
    });

    expect(killedIds).toEqual(["fake-sb-old", "fake-sb-new"]);
    // No owner line, as in a run from 0.110.0 or earlier: every receipt is gone, but a sandbox whose
    // id never reached a receipt carries no tags to search for, so it cannot be ruled out.
    expect(result).toMatchObject({ ok: false, state: "unknown" });
    // The release that added owner lines is 0.110.1; the warning names the last one without them.
    expect(result.warnings.join("\n")).toContain(
      "records no owner tags, so a sandbox whose id never reached a receipt cannot be ruled out: the run is from humanish 0.110.0 or earlier, it created no sandbox, or its journal lost those lines. Each sandbox's create-time timeout is the backstop.",
    );
  });

  it("reclaims by recorded exact id: kills the living, reports the gone, fails loud on a provider error, dedupes racing receipts", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    expect(runPaths).not.toBeNull();

    await appendSandboxReceipt(runPaths!, {
      at: "t1",
      laneId: "lane-01",
      sandboxId: "fake-sb-alive",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t2",
      laneId: "lane-02",
      sandboxId: "fake-sb-gone",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t3",
      laneId: "lane-03",
      sandboxId: "fake-sb-broken",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t4",
      laneId: "lane-01",
      sandboxId: "fake-sb-alive",
    }); // raced duplicate

    const killedIds: string[] = [];
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () =>
        fakeModule(
          { "fake-sb-alive": "ok", "fake-sb-gone": "not-found-throw", "fake-sb-broken": "boom" },
          killedIds,
        ),
    });

    // One attempt per unique id, exactly the journaled ids, nothing else.
    expect(killedIds.sort()).toEqual(["fake-sb-alive", "fake-sb-broken", "fake-sb-gone"]);
    expect(result.receiptCount).toBe(4);
    // Outcomes name each sandbox by digest; the kills above went to the raw ids.
    const states = Object.fromEntries(result.outcomes.map((o) => [o.sandboxIdDigest, o.state]));
    expect(states).toEqual({
      [sandboxIdDigest("fake-sb-alive")]: "killed",
      [sandboxIdDigest("fake-sb-gone")]: "already-gone",
      [sandboxIdDigest("fake-sb-broken")]: "kill-failed",
    });
    expect(result.outcomes.every((o) => o.sandboxId === REDACTED_SANDBOX_ID)).toBe(true);
    // A kill-failed means the reclaim did not fully succeed: the exit says so, and the TTL is the
    // backstop.
    expect(result.ok).toBe(false);
    expect(result.state).toBe("unconfirmed");

    // The reclaim record lands next to the run it cleaned.
    const receipt = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", result.runId, RECLAIM_RECEIPT_ARTIFACT),
        "utf8",
      ),
    );
    expect(receipt.outcomes).toHaveLength(3);
  });

  it("an unknown run fails closed with RUN_NOT_FOUND", async () => {
    const result = await reclaimRunSandboxes(cwd, "no-such-run", {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_RECLAIM_RUN_NOT_FOUND");
  });

  it(`the receipts artifact name is stable public surface (${SANDBOX_RECEIPTS_ARTIFACT})`, () => {
    expect(SANDBOX_RECEIPTS_ARTIFACT).toBe("sandbox-receipts.ndjson");
  });
});

// The search by tag, concurrent kills with the receipt written first, and the read-only check.
describe("humanish reclaim beyond the receipts", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-tags-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("calls a run with no receipts clean only after E2B lists nothing with its exact tags", async () => {
    const runPaths = await dryRun(cwd);
    const queries: unknown[] = [];
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, [], { queries }),
    });
    expect(result).toMatchObject({ ok: true, state: "clean", receiptCount: 0 });
    expect(result.tagSearch).toEqual({ status: "done", found: 0 });
    expect(queries).toEqual([
      expect.objectContaining({ query: { metadata: sandboxOwnerTags(runPaths) } }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("says unknown, not clean, when E2B cannot be searched by tag", async () => {
    await dryRun(cwd);
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, [], { listError: new Error("401: Invalid API key") }),
    });
    expect(result).toMatchObject({ ok: false, state: "unknown", receiptCount: 0 });
    expect(result.tagSearch).toMatchObject({ status: "failed", detail: "401: Invalid API key" });
    const receipt = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", result.runId, RECLAIM_RECEIPT_ARTIFACT),
        "utf8",
      ),
    ) as { state: string };
    expect(receipt.state).toBe("unknown");
  });

  it("kills a sandbox that never reached a receipt, found by the run's exact tags", async () => {
    const runPaths = await dryRun(cwd);
    const tags = sandboxOwnerTags(runPaths);
    const killedIds: string[] = [];
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () =>
        fakeModule({ "fake-sb-unreceipted": "ok", "fake-sb-other-run": "ok" }, killedIds, {
          // A server that ignored the filter would also return another run's sandbox; reclaim
          // checks every tag itself and leaves that one alone.
          listed: [
            {
              sandboxId: "fake-sb-unreceipted",
              metadata: { ...tags, participantId: "p1" },
              state: "running",
            },
            {
              sandboxId: "fake-sb-other-run",
              metadata: { ...tags, runKey: "0000000000000000" },
              state: "running",
            },
          ],
        }),
    });
    expect(killedIds).toEqual(["fake-sb-unreceipted"]);
    expect(result).toMatchObject({ ok: true, state: "clean" });
    expect(result.tagSearch).toEqual({ status: "done", found: 1 });
    expect(result.outcomes).toEqual([
      {
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest("fake-sb-unreceipted"),
        laneId: "p1",
        source: "tag",
        state: "killed",
      },
    ]);
  });

  it("kills every sandbox concurrently and writes the receipt before the first kill answers", async () => {
    const runPaths = await dryRun(cwd);
    const ids = Array.from({ length: 12 }, (_, index) => `fake-sb-${index + 1}`);
    for (const [index, sandboxId] of ids.entries())
      await appendSandboxReceipt(runPaths, { at: `t${index}`, laneId: "lane-01", sandboxId });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const killedIds: string[] = [];
    const reclaiming = reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () =>
        fakeModule(Object.fromEntries(ids.map((id) => [id, "ok" as const])), killedIds, { hold }),
    });
    // Every kill, the newest included, is in flight before any one answers.
    await vi.waitFor(() => expect(killedIds).toHaveLength(12));
    const file = path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT);
    const pending = JSON.parse(await readFile(file, "utf8")) as {
      state: string;
      outcomes: { state: string }[];
    };
    // An exit now would leave this record: every sandbox named, none yet confirmed.
    expect(pending.state).toBe("unknown");
    expect(pending.outcomes.map((outcome) => outcome.state)).toEqual(Array(12).fill("pending"));
    release();
    const result = await reclaiming;
    expect(result.state).toBe("clean");
    const final = JSON.parse(await readFile(file, "utf8")) as { outcomes: { state: string }[] };
    expect(final.outcomes.map((outcome) => outcome.state)).toEqual(Array(12).fill("killed"));
  });
});

// A later reclaim keeps an earlier one's record, and --check only reads.
describe("humanish reclaim after a reclaim, and --check", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-again-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps an earlier reclaim's record of sandboxes no receipt names", async () => {
    const runPaths = await dryRun(cwd);
    const outcome = (id: string, state: string) => ({
      sandboxId: REDACTED_SANDBOX_ID,
      sandboxIdDigest: sandboxIdDigest(id),
      laneId: "p1",
      source: "create",
      state,
    });
    // What a signal handler wrote: one sandbox killed as its create returned, one still pending
    // when the process exited.
    await writeFile(
      path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT),
      JSON.stringify({
        schema: "humanish.reclaim-result.v1",
        runId: runIdOf(runPaths),
        state: "unknown",
        receiptCount: 0,
        outcomes: [outcome("fake-sb-killed", "killed"), outcome("fake-sb-pending", "pending")],
      }),
    );
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, []),
    });
    // E2B lists neither with the run's tags, so the pending one is gone too.
    expect(result.state).toBe("clean");
    expect(result.outcomes).toEqual([
      outcome("fake-sb-killed", "killed"),
      {
        ...outcome("fake-sb-pending", "already-gone"),
        detail: expect.stringContaining("no longer lists it"),
      },
    ]);
    const written = JSON.parse(
      await readFile(path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT), "utf8"),
    ) as { outcomes: unknown[] };
    expect(written.outcomes).toHaveLength(2);
  });

  it("searches by the tags the run recorded, so a copied run directory still finds its sandbox", async () => {
    const runPaths = await dryRun(cwd);
    // The directory the sandbox was created from had another inode, so another runKey.
    const original = { ...sandboxOwnerTags(runPaths), runKey: "1".repeat(16) };
    await appendSandboxOwner(runPaths, original);
    const queries: unknown[] = [];
    const killedIds: string[] = [];
    const module = fakeModule({ "fake-sb-copied": "ok" }, killedIds, { queries });
    const list = module.Sandbox.list!.bind(module.Sandbox);
    module.Sandbox.list = (options) => {
      const pages = list(options);
      const asked = options?.query?.metadata?.runKey;
      return {
        get hasNext() {
          return pages.hasNext;
        },
        nextItems: async () => {
          await pages.nextItems();
          return asked === original.runKey
            ? [{ sandboxId: "fake-sb-copied", metadata: { ...original, participantId: "p1" } }]
            : [];
        },
      };
    };
    const result = await reclaimRunSandboxes(cwd, "latest", { loadModule: async () => module });
    expect(killedIds).toEqual(["fake-sb-copied"]);
    expect(queries).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, state: "clean", tagSearch: { found: 1 } });
  });

  it("records a sandbox found by tag as pending before its kill starts", async () => {
    const runPaths = await dryRun(cwd);
    const receiptFile = path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT);
    const atKill: string[] = [];
    const module = fakeModule({ "fake-sb-tagged": "ok" }, [], {
      listed: [{ sandboxId: "fake-sb-tagged", metadata: sandboxOwnerTags(runPaths) }],
    });
    const kill = module.Sandbox.kill!.bind(module.Sandbox);
    module.Sandbox.kill = async (sandboxId, options) => {
      atKill.push(await readFile(receiptFile, "utf8"));
      return kill(sandboxId, options);
    };
    await reclaimRunSandboxes(cwd, "latest", { loadModule: async () => module });
    const [written] = atKill.map((text) => JSON.parse(text) as { outcomes: unknown[] });
    expect(written?.outcomes).toEqual([
      expect.objectContaining({
        sandboxIdDigest: sandboxIdDigest("fake-sb-tagged"),
        state: "pending",
      }),
    ]);
  });

  it("keeps an earlier receipt's unconfirmed kill when no tag could have found that sandbox", async () => {
    const runPaths = await dryRun(cwd);
    // A pre-0.110 reclaim receipt names a raw id that no current journal line holds.
    await writeFile(
      path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT),
      JSON.stringify({
        schema: "humanish.reclaim-result.v1",
        runId: runIdOf(runPaths),
        receiptCount: 1,
        outcomes: [{ sandboxId: "fake-sb-legacy", laneId: "lane-01", state: "kill-failed" }],
      }),
    );
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, []),
    });
    expect(result.state).toBe("unconfirmed");
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        sandboxIdDigest: sandboxIdDigest("fake-sb-legacy"),
        source: "receipt",
        state: "kill-failed",
      }),
    ]);
  });

  it("--check asks E2B by id and by tag, and kills and writes nothing", async () => {
    const runPaths = await dryRun(cwd);
    await appendSandboxReceipt(runPaths, { at: "t1", laneId: "lane-01", sandboxId: "fake-sb-up" });
    await appendSandboxReceipt(runPaths, {
      at: "t2",
      laneId: "lane-02",
      sandboxId: "fake-sb-down",
    });
    const killedIds: string[] = [];
    const module = fakeModule({}, killedIds, { info: { "fake-sb-up": "running" } });

    const result = await reclaimRunSandboxes(cwd, "latest", {
      check: true,
      loadModule: async () => module,
    });

    expect(killedIds).toEqual([]);
    expect(result).toMatchObject({ ok: false, state: "running", mode: "check" });
    expect(Object.fromEntries(result.outcomes.map((o) => [o.laneId, o.state]))).toEqual({
      "lane-01": "running",
      "lane-02": "already-gone",
    });
    await expect(
      readFile(path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const clean = await reclaimRunSandboxes(cwd, "latest", {
      check: true,
      loadModule: async () => fakeModule({}, killedIds),
    });
    expect(clean).toMatchObject({ ok: true, state: "clean" });
  });
});

// Which owner lines count, and what a run without one may claim.
describe("humanish reclaim and owner lines", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-owner-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("ignores an owner line that is partial or names another run, and calls nothing clean", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = (await resolveRunPath(cwd, "latest"))!;
    const own = sandboxOwnerTags(runPaths);
    await writeFile(
      path.join(runPaths.absoluteRunRoot, SANDBOX_RECEIPTS_ARTIFACT),
      [
        { provider: "e2b", owner: { tool: "humanish" } },
        { provider: "e2b", owner: { ...own, runId: "another-run" } },
        { provider: "e2b", owner: { ...own, extra: "x" } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    const queries: { query?: { metadata?: Record<string, string> } }[] = [];
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, [], { queries }),
    });
    // Only the directory's own complete tuple is searched, and without a valid owner line the
    // empty search proves nothing.
    expect(queries.map((query) => query.query?.metadata)).toEqual([own]);
    expect(result.state).toBe("unknown");
  });

  it("leaves an earlier unconfirmed create outcome alone when the run recorded no tags", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = (await resolveRunPath(cwd, "latest"))!;
    await writeFile(
      path.join(runPaths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT),
      JSON.stringify({
        schema: "humanish.reclaim-result.v1",
        runId: runIdOf(runPaths),
        receiptCount: 0,
        outcomes: [
          {
            sandboxId: REDACTED_SANDBOX_ID,
            sandboxIdDigest: sandboxIdDigest("fake-sb-elsewhere"),
            laneId: "p1",
            source: "create",
            state: "pending",
          },
        ],
      }),
    );
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, []),
    });
    expect(result.state).toBe("unconfirmed");
    expect(result.outcomes).toEqual([expect.objectContaining({ state: "pending" })]);
  });
});

describe("reclaim of unreadable receipts", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-unreadable-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // Root reads a mode-000 file anyway, so this case needs an unprivileged user.
  it.skipIf(process.getuid?.() === 0)(
    "reports receipts it cannot read instead of claiming there are none",
    async () => {
      const run = await runTerminalProductStudy({
        cwd,
        config: dryRunConfig(),
        dryRun: true,
        open: false,
      });
      expect(run.ok).toBe(true);
      const runPaths = await resolveRunPath(cwd, "latest");
      await appendSandboxReceipt(runPaths!, {
        at: "t1",
        laneId: "lane-01",
        sandboxId: "fake-sb-hidden",
      });
      await chmod(path.join(runPaths!.absoluteRunRoot, SANDBOX_RECEIPTS_ARTIFACT), 0o000);
      const killedIds: string[] = [];

      const result = await reclaimRunSandboxes(cwd, "latest", {
        loadModule: async () => fakeModule({}, killedIds),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_RECLAIM_RECEIPTS_UNREADABLE");
      expect(result.warnings.join("\n")).not.toContain("No sandbox-receipts.ndjson");
      expect(killedIds).toEqual([]);
    },
  );
});

describe("reclaim with E2B_DEBUG=true", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-debug-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses before loading the SDK and keeps the receipts", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    if (!runPaths) throw new Error("dry run left no run");
    await appendSandboxReceipt(runPaths, {
      at: "t1",
      laneId: "lane-01",
      sandboxId: "fake-sb-alive",
    });
    vi.stubEnv("E2B_DEBUG", "true");
    const killedIds: string[] = [];
    const loadModule = vi.fn(async () => fakeModule({ "fake-sb-alive": "ok" }, killedIds));

    const result = await reclaimRunSandboxes(cwd, "latest", { loadModule });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_RECLAIM_E2B_DEBUG");
    expect(result.error?.message).toContain("E2B_DEBUG");
    expect(result.outcomes).toEqual([]);
    expect(loadModule).not.toHaveBeenCalled();
    expect(killedIds).toEqual([]);
    const runDir = path.join(cwd, ".humanish", "runs", runIdOf(runPaths));
    await expect(readFile(path.join(runDir, RECLAIM_RECEIPT_ARTIFACT))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      parseSandboxReceipts(await readFile(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT), "utf8")),
    ).toHaveLength(1);
  });

  it("exits 2 from the CLI with the refusal code", async () => {
    vi.stubEnv("E2B_DEBUG", "True");
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
    await program.parseAsync(["node", "humanish", "reclaim", "--cwd", cwd, "--json"], {
      from: "node",
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_RECLAIM_E2B_DEBUG" },
    });
  });
});
