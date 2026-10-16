// `humanish export --format bundle` on a run whose participant carries a browser network log. The
// derivative copies the log byte for byte, so it still matches the index the derivative's run.json
// keeps, and the derivative grades as its source does. A regression guard: export kept such a file
// intact before the log existed, and this keeps a later change to export from breaking it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportRun } from "../../src/feedback/export.js";
import { loadRunBundle } from "../../src/run/locate.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { addNetworkLog } from "../helpers/network-log-run.js";

const RUN = "network-log-export";

describe("a bundle export of a run with a network log", () => {
  let cwd: string;
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("copies the log byte for byte, and the derivative grades as its source", async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-network-log-export-"));
    expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
    const { text, index } = await addNetworkLog(path.join(cwd, ".humanish", "runs", RUN));
    const source = await verifyRun(cwd, RUN);
    expect(source.shareSafety.status).toBe("share_ready");

    const result = await exportRun(cwd, RUN, {
      format: "bundle",
      redactScreenshots: true,
      out: "shared",
    });
    if (!result.ok) throw new Error(result.error.message);
    const shared = path.join(cwd, "shared");
    const derivativeDir = path.join(shared, ".humanish", "runs", RUN);
    expect(await readFile(path.join(derivativeDir, "network", "p1.ndjson"), "utf8")).toBe(text);
    expect((await loadRunBundle(shared, RUN))?.bundle.streams[0]?.network).toEqual(index);
    const derivative = await verifyRun(shared, RUN);
    expect({
      status: derivative.shareSafety.status,
      codes: derivative.shareSafety.reasons.map((reason) => reason.code),
    }).toEqual({
      status: source.shareSafety.status,
      codes: source.shareSafety.reasons.map((reason) => reason.code),
    });
  });
});
