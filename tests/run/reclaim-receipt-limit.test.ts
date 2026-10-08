// The receipt an earlier reclaim wrote is replaced by the next one, so a receipt reclaim cannot read
// stops it before it kills or writes anything: the outcomes it records are kept.
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
function emptyE2B(killed: string[]): E2BDesktopModule {
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

it("refuses before it kills or writes when the earlier receipt is over the read limit", async () => {
  const cwd = await makeTestTempDir("humanish-reclaim-receipt-limit-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
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
