// Readers that show a run (run detail, the Observer server) load traces through the same loader
// and v2 rules as verify. A participant whose trace the loader refused shows that its evidence is
// unavailable, with the reason, and none of the items run.json or a file supplied for it.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureEvidence } from "../../src/analysis/evidence.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { readRunDetail } from "../../src/run/detail.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticActor, writeTwoParticipantRun } from "../helpers/run-traces.js";

const RUN = "synthetic-trace-readers";
const thought = (text: string) =>
  syntheticActor(text, { id: "r1", kind: "reasoning", title: "thinking" });
const forged = thought("FORGED").items;

describe("readers of a v2 run's traces", () => {
  let cwd: string;
  let runDir: string;
  let stored: RunBundle;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-trace-readers-"));
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    stored = await writeTwoParticipantRun(runDir, [
      thought("First look."),
      thought("Second look."),
    ]);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const writeStored = (bundle: RunBundle) =>
    writeFile(path.join(runDir, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`);

  /** The Observer server's data for the run. */
  async function served(): Promise<string> {
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    try {
      const response = await fetch(
        new URL(`/_humanish/runs/${RUN}/observer/observer-data.json`, started.server.url),
      );
      expect(response.status).toBe(200);
      return await response.text();
    } finally {
      await started.server.close();
    }
  }

  const tampered: [string, (bundle: RunBundle) => void][] = [
    [
      "an actor with inline items and no index",
      (bundle) => {
        const { trace: _index, ...stream } = bundle.streams[0]!;
        bundle.streams[0] = { ...stream, actor: { ...stream.actor!, items: forged } };
      },
    ],
    [
      "inline items beside an index",
      (bundle) => {
        bundle.streams[0]!.actor = { ...bundle.streams[0]!.actor!, items: forged };
      },
    ],
    [
      "in-progress items in a finished run",
      (bundle) => {
        bundle.streams[0]!.liveActor = {
          schema: "humanish.live-actor.v1",
          updatedAt: "2026-09-01T00:00:01.000Z",
          items: forged,
        };
      },
    ],
  ];

  it.each(tampered)("run detail shows unavailable evidence for %s", async (_name, tamper) => {
    tamper(stored);
    await writeStored(stored);
    const detail = await readRunDetail(cwd, RUN);
    expect(JSON.stringify(detail)).not.toContain("FORGED");
    const [first, second] = detail!.participants;
    expect(first!.thought).toBeUndefined();
    expect(first!.evidenceUnavailable).toMatch(/stream-one/);
    expect(second!.thought?.text).toBe("Second look.");
  });

  it.each(tampered)(
    "the Observer server shows unavailable evidence for %s",
    async (_name, tamper) => {
      tamper(stored);
      await writeStored(stored);
      const data = await served();
      expect(data).not.toContain("FORGED");
      const streams = (
        JSON.parse(data) as {
          streams: { id: string; traceUnavailable?: string; timeline: { type: string }[] }[];
        }
      ).streams;
      const first = streams.find((stream) => stream.id === "stream-one")!;
      expect(first.traceUnavailable).toMatch(/stream-one/);
      expect(first.timeline.map((event) => event.type)).toContain("trace.unavailable");
    },
  );

  it("the Observer server does not fall back to saved data when a trace's digest differs", async () => {
    const saved = path.join(runDir, "observer", "observer-data.json");
    await writeFile(saved, (await readFile(saved, "utf8")).replace("dry run", "STALE dry run"));
    const file = path.join(runDir, stored.streams[0]!.trace!.path);
    await writeFile(file, (await readFile(file, "utf8")).replace("First look.", "First lOok."));
    const data = await served();
    expect(data).not.toContain("STALE");
    expect(data).not.toContain("First lOok.");
    const streams = (JSON.parse(data) as { streams: { id: string; traceUnavailable?: string }[] })
      .streams;
    expect(streams.find((stream) => stream.id === "stream-one")?.traceUnavailable).toMatch(
      /sha256/,
    );
  });

  it("refuses two participants that index one trace file", async () => {
    stored.streams[1]!.trace = structuredClone(stored.streams[0]!.trace!);
    await writeStored(stored);
    const verified = await verifyRun(cwd, RUN);
    expect(verified.ok).toBe(false);
    expect(verified.shareSafety.status).toBe("blocked");
    const prepared = (await resolveRunPath(cwd, RUN))!;
    await expect(
      captureEvidence(prepared, await readFile(path.join(runDir, "run.json"))),
    ).rejects.toThrow("ANALYSIS_SOURCE_INVALID");
  });
});
