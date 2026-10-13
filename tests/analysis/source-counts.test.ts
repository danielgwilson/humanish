// Analysis reads a run whose files fit its byte limits, whatever the count of run events, trace
// items or screenshot frames. Each run here is a compact v1 run.json under the 16 MiB source limit
// and passes 100,000 in the count its test names.

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { RunEvent } from "../../src/run/bundle.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";

const RUN_ID = "count-fixture";
const OLD_CAP = 100_000;

describe("analysis past 100,000 events, items and frames", () => {
  let cwd: string;
  let prepared: PreparedRunArtifactPaths;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-source-counts-"));
    prepared = await prepareRunArtifactPaths(cwd, RUN_ID);
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  /** run.json with one finished participant holding `items`, and `events`; returns its bytes. */
  async function save(items: ActorTraceItem[], events: RunEvent[] = []): Promise<Buffer> {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: "humanish.run-bundle.v1",
        runId: RUN_ID,
        streams: [
          {
            id: "p",
            label: "p",
            status: "passed",
            assignment: { mission: "Use the synthetic app." },
            actor: { lane: "computer-use", status: "passed", items },
          },
        ],
        events,
      }),
    );
    await fs.writeFile(path.join(prepared.physicalRunRoot, "run.json"), bytes);
    return bytes;
  }

  it("reads a run.json with 100,001 events", async () => {
    const events = Array.from({ length: OLD_CAP + 1 }, (_, index): RunEvent => ({
      id: `e${index}`,
      at: "2026-10-13T00:00:00.000Z",
      level: "info",
      type: "t",
      message: "",
      streamId: "p",
    }));
    const input = await captureEvidence(prepared, await save([], events));
    expect(input.evidence.at(-1)?.eventId).toBe(`e${OLD_CAP}`);
  }, 60_000);

  it("reads a participant trace with 100,001 items", async () => {
    const items = Array.from({ length: OLD_CAP + 1 }, (_, index): ActorTraceItem => ({
      id: `i${index}`,
      kind: "message",
      lifecycle: "completed",
      title: "",
      text: "",
    }));
    const input = await captureEvidence(prepared, await save(items));
    expect(input.evidence.map((entry) => entry.eventId)).toContain(`i${OLD_CAP}`);
  }, 60_000);

  it("gives the last of 100,002 screenshots frame 100,001", async () => {
    const items = Array.from({ length: OLD_CAP + 2 }, (_, index): ActorTraceItem => ({
      id: `s${index}`,
      kind: "screenshot",
      lifecycle: "completed",
      title: "",
      screenshotRef: { path: "s.png", redaction: "none" },
    }));
    const input = await captureEvidence(prepared, await save(items));
    expect(input.evidence.find((entry) => entry.eventId === `s${OLD_CAP + 1}`)?.frame).toBe(
      OLD_CAP + 1,
    );
  }, 60_000);
});
