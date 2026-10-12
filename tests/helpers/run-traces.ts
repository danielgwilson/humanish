import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  type ActorTrace,
  type ActorTraceItem,
} from "../../src/actors/contract.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { loadStreamTraces, splitStreamTraces } from "../../src/run/stream-trace.js";

/**
 * run.json from a run folder with each stream's trace file joined by the production loader, so a
 * test reads the items and screenshot entries a v1 run.json held inline. A refused trace throws.
 */
export async function readRunWithTraces(runDir: string): Promise<RunBundle> {
  const stored = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  const loaded = await loadStreamTraces(
    async (relativePath) => ({ bytes: await readFile(path.join(runDir, relativePath)) }),
    stored,
  );
  if (loaded.refused[0]) throw loaded.refused[0];
  return loaded.bundle;
}

/**
 * Write a bundle into a run folder as the run writer does: each trace file through the
 * production splitter, then run.json v2.
 */
export async function writeRunBundle(runDir: string, bundle: RunBundle): Promise<RunBundle> {
  const split = splitStreamTraces(bundle);
  for (const file of split.files) {
    await mkdir(path.dirname(path.join(runDir, file.path)), { recursive: true });
    await writeFile(path.join(runDir, file.path), file.bytes);
  }
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(split.bundle, null, 2)}\n`);
  return split.bundle;
}

/** A finished computer-use trace whose one item is `item` (a message with `text` by default). */
export function syntheticActor(text: string, item: Partial<ActorTraceItem> = {}): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "synthetic-fixture",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "synthetic-new-user", traitsApplied: [], promptDigest: "0123456789abcdef" },
    redaction: { status: "passed", screenshots: "blurred", notes: "Synthetic fixture." },
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:00:01.000Z",
    durationMs: 1000,
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "Synthetic fixture completed.",
    ids: {},
    modelSettings: { reasoningEffort: "low", maxOutputTokens: 4096 },
    counts: { messages: 1, actions: 0 },
    items: [{ id: "i1", kind: "message", lifecycle: "completed", title: "message", text, ...item }],
    capabilities: {
      ...CODEX_APP_SERVER_CAPABILITIES,
      lanes: ["computer-use"],
      producesScreenshots: true,
    },
  };
}

/** A dry run's bundle with two participants, `stream-one` and `stream-two`, written as v2. */
export async function writeTwoParticipantRun(
  runDir: string,
  actors: [ActorTrace, ActorTrace],
): Promise<RunBundle> {
  const dryRun = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  const [template] = dryRun.streams;
  const [simulation] = dryRun.simulations;
  if (!template || !simulation) throw new Error("the dry run wrote no participant");
  return writeRunBundle(runDir, {
    ...dryRun,
    streams: [
      { ...template, id: "stream-one", simId: simulation.id, actor: actors[0] },
      { ...template, id: "stream-two", simId: simulation.id, actor: actors[1] },
    ],
    simulations: [{ ...simulation, streamIds: ["stream-one", "stream-two"] }],
  });
}
