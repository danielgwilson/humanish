// A participant's network log through Run.finish. The finish sweeps each journaled sandbox id out
// of the run's text files after run.json indexes them, so the writer scrubs the participant's own
// id first: a swept log would no longer match the sha256 its index records.

import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reduceBrowserNetwork } from "../../src/evidence/browser-network.js";
import { redactText, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { traceRedaction } from "../../src/evidence/trace-page.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { writeContainedOutputFile } from "../../src/run/contained-output.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope } from "../../src/run/run.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import { verifyRun } from "../../src/verify/verify.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";

const SITE = "http://127.0.0.1:3000";

describe("a finished run's network log", () => {
  let cwd: string;
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("still matches its index after the sandbox id sweep, and names no raw sandbox id", async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-network-log-sweep-"));
    // No digit, so tracePage keeps it as a path segment; built at run time, so this file holds none.
    const raw = ["qwertyuiop", "asdfghjklz"].join("");
    const events = [
      { e: "start", wallTime: 1792116685.37 },
      {
        e: "request",
        id: "0:1",
        wallTime: 1792116685.5,
        timestamp: 9.5,
        url: `${SITE}/`,
        method: "GET",
        type: "Document",
      },
      { e: "response", id: "0:1", timestamp: 9.52, status: 200 },
      { e: "finished", id: "0:1", timestamp: 9.53 },
      {
        e: "request",
        id: "0:2",
        wallTime: 1792116686.1,
        timestamp: 10.1,
        url: `${SITE}/sandboxes/${raw}`,
        method: "GET",
        type: "Fetch",
      },
      { e: "response", id: "0:2", timestamp: 10.12, status: 404 },
      { e: "finished", id: "0:2", timestamp: 10.13 },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");
    const log = reduceBrowserNetwork({
      participantId: "lane-01",
      origins: [SITE],
      events,
      marks: [{ wallTime: 1792116686.0, turn: 0 }],
      redact: traceRedaction((text) => text, redactText),
      sandboxId: raw,
    });

    await runDryRun({ cwd, dryRun: true, runId: "template" });
    const template = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "template", "run.json"), "utf8"),
    ) as RunBundle;
    const [stream] = template.streams;
    const runId = "with-network";
    await runScope(async (scope) => {
      const started = await scope.startRun({
        cwd,
        runId,
        mintRunId: () => "minted",
        mode: "dry-run",
        renderReview: (bundle) => `# Review ${bundle.runId}\n`,
        observer: { open: false },
      });
      if (!started.ok) throw new Error(started.message);
      await appendSandboxReceipt(started.run.paths, { at: "t", laneId: "lane-01", sandboxId: raw });
      // The E2B desktop writes the log at teardown, before the run finishes.
      await writeContainedOutputFile(started.run.paths, log.index.path!, log.text!, "utf8");
      await started.run.finish(
        {
          ...template,
          runId,
          artifactRoot: path.join(".humanish", "runs", runId),
          streams: [
            {
              ...stream!,
              laneId: "lane-01",
              network: log.index,
              artifacts: [
                ...stream!.artifacts,
                { label: "participant lane-01 network log", path: log.index.path!, kind: "log" },
              ],
            },
          ],
        },
        PASSING_OUTCOME,
      );
    });

    const dir = path.join(cwd, ".humanish", "runs", runId);
    const written = await readFile(path.join(dir, "network", "lane-01.ndjson"), "utf8");
    expect(written).toBe(log.text);
    expect(written).toContain(`/sandboxes/[redacted-sandbox-id ${sandboxIdDigest(raw)}]`);
    const verified = await verifyRun(cwd, runId);
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.ok).toBe(true);
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).not.toContain(
      "RAW_SANDBOX_ID",
    );
  });
});
