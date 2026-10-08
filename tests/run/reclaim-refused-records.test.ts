// A run record reclaim cannot read decides nothing. The receipt an earlier reclaim wrote is replaced
// by the next one, so one it cannot read stops reclaim before it kills or writes anything. A
// run.json or status.json it cannot read cannot agree that the run made no sandbox.
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { RECLAIM_RECEIPT_ARTIFACT, reclaimRunSandboxes } from "../../src/run/reclaim.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "reclaim-receipt-limit";

/** An E2B module that lists no sandbox and records every kill. */
function emptyE2B(killed: string[] = []): E2BDesktopModule {
  return {
    Sandbox: {
      async kill(sandboxId: string) {
        killed.push(sandboxId);
        return false;
      },
      list() {
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
    },
  } as unknown as E2BDesktopModule;
}

async function dryRun(): Promise<{ cwd: string; runDir: string }> {
  const cwd = await makeTestTempDir("humanish-reclaim-refused-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
  return { cwd, runDir: path.join(cwd, ".humanish", "runs", RUN) };
}

it("reclaims in full when run.json is over the read limit and status.json says dry-run", async () => {
  const { cwd, runDir } = await dryRun();
  // A live run.json, which trailing whitespace takes past the 32 MiB a run file is read to. The
  // status.json beside it still says dry-run.
  const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as object;
  await writeFile(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ ...bundle, mode: "live" })}${" ".repeat(32 * 1024 * 1024)}`,
  );
  let loaded = false;

  const result = await reclaimRunSandboxes(cwd, RUN, {
    loadModule: async () => {
      loaded = true;
      return emptyE2B();
    },
  });

  expect(result.reason).toBeUndefined();
  expect(loaded).toBe(true);
});

it("refuses before it kills or writes when the earlier receipt is over the read limit", async () => {
  const { cwd } = await dryRun();
  const receiptFile = path.join(cwd, ".humanish", "runs", RUN, RECLAIM_RECEIPT_ARTIFACT);
  // A valid receipt, which trailing whitespace takes past the 32 MiB a run file is read to.
  const earlier = JSON.stringify({
    schema: "humanish.reclaim-result.v1",
    runId: RUN,
    state: "unknown",
    receiptCount: 0,
    outcomes: [
      {
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest("fake-sb-pending"),
        laneId: "p1",
        source: "create",
        state: "pending",
      },
    ],
  });
  const padding = 32 * 1024 * 1024;
  await writeFile(receiptFile, `${earlier}${" ".repeat(padding)}`);
  const killed: string[] = [];

  const result = await reclaimRunSandboxes(cwd, RUN, { loadModule: async () => emptyE2B(killed) });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "HUMANISH_RECLAIM_RECEIPTS_UNREADABLE",
      message: expect.stringContaining("reclaim-receipt.json is larger than 33554432 bytes"),
    },
  });
  expect(killed).toEqual([]);
  const kept = await readFile(receiptFile, "utf8");
  expect(kept.length).toBe(earlier.length + padding);
  expect(kept.startsWith(earlier)).toBe(true);
});
