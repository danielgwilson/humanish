// A dry run reshaped into a recorded run with timed captures, for reviewer notes. Two
// participants: the first captures from the run's first second, the second joins 20 s later.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

import {
  ACTOR_TRACE_SCHEMA,
  type ActorTrace,
  type ActorTraceItem,
} from "../../src/actors/contract.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";

/** The first capture of the run: the run clock's 00:00. */
const TIMED_RUN_START = Date.parse("2026-05-01T10:00:00.000Z");

const at = (seconds: number): string => new Date(TIMED_RUN_START + seconds * 1000).toISOString();

function capture(id: string, seconds: number): ActorTraceItem {
  return {
    id,
    kind: "screenshot",
    lifecycle: "completed",
    title: "screenshot",
    at: at(seconds),
    screenshotRef: { path: `screenshots/${id}.png`, redaction: "blurred" },
  };
}

function trace(items: ActorTraceItem[]): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "openai-responses-cu",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    redaction: { status: "passed", screenshots: "blurred", notes: "synthetic test trace" },
    startedAt: items[0]?.at ?? at(0),
    completedAt: items.at(-1)?.at ?? at(0),
    durationMs: 151_000,
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "model reported a natural endpoint with no further action",
    ids: { model: "computer-use-preview" },
    counts: {
      turns: items.length,
      actions: 1,
      screenshots: items.filter((item) => item.kind === "screenshot").length,
      reasonings: 0,
      messages: 1,
      idleTurns: 0,
      noProgressTurns: 0,
    },
    items,
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary",
    },
  };
}

/**
 * The first participant, "First visitor" (participant id first-visitor): captures at 00:00, 01:00
 * and 02:31, a click at 00:40, a message at 02:30.
 */
export const FIRST_PARTICIPANT = "stream-one";
/** The second participant, "Second visitor" (second-visitor): captures at 00:20 and 01:30. */
export const SECOND_PARTICIPANT = "stream-two";

/**
 * Copies the minimal app into `cwd`, writes a dry run under `runId` and gives it two participants
 * with timed captures. The run clock runs from 00:00 to 02:31.
 */
export async function writeTimedRun(cwd: string, runId: string): Promise<string> {
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  const result = await runDryRun({ cwd, dryRun: true, runId });
  if (!result.ok) throw new Error(result.error?.message ?? "the dry run failed");
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  const bundlePath = path.join(runDir, "run.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
  const [template] = bundle.streams;
  const [participant] = bundle.simulations;
  if (!template || !participant) throw new Error("the dry run wrote no participant");
  const first = [
    capture("capture-001", 0),
    {
      id: "action-001",
      kind: "ui_action",
      lifecycle: "completed",
      title: "click (11, 22)",
      at: at(40),
    },
    capture("capture-002", 60),
    {
      id: "message-001",
      kind: "message",
      lifecycle: "completed",
      title: "message",
      text: "Done.",
      at: at(150),
    },
    capture("capture-003", 151),
  ] satisfies ActorTraceItem[];
  const second = [capture("capture-101", 20), capture("capture-102", 90)];
  bundle.simulations = [
    { ...participant, id: "participant-one", index: 1, streamIds: [FIRST_PARTICIPANT] },
    { ...participant, id: "participant-two", index: 2, streamIds: [SECOND_PARTICIPANT] },
  ];
  bundle.simCount = 2;
  bundle.streams = [
    {
      ...template,
      id: FIRST_PARTICIPANT,
      laneId: "first-visitor",
      simId: "participant-one",
      label: "First visitor",
      actor: trace(first),
    },
    {
      ...template,
      id: SECOND_PARTICIPANT,
      laneId: "second-visitor",
      simId: "participant-two",
      label: "Second visitor",
      actor: trace(second),
    },
  ];
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await mkdir(path.join(runDir, "screenshots"), { recursive: true });
  const pixels = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  for (const item of [...first, ...second])
    if (item.screenshotRef) await writeFile(path.join(runDir, item.screenshotRef.path), pixels);
  return runDir;
}
