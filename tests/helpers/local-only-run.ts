import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../../src/actors/contract.js";
import type { CuaLoopResult } from "../../src/actors/computer-use/loop.js";
import { buildSingleParticipantBundle } from "../../src/routes/computer-use/single-bundle.js";
import { buildRunSource } from "../../src/run/bundle.js";
import { verdictForStatus } from "../../src/run/judge.js";

export function rawScreenshotActorTrace(): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "openai-responses-cu",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    redaction: {
      status: "passed",
      screenshots: "raw",
      notes: "synthetic public-safe test trace",
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5_000,
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "model reported a natural endpoint with no further action",
    ids: { model: "computer-use-preview" },
    counts: {
      turns: 2,
      actions: 1,
      screenshots: 0,
      reasonings: 0,
      messages: 1,
      idleTurns: 0,
      noProgressTurns: 0,
    },
    items: [
      { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "click (11, 22)" },
      {
        id: "message-001",
        kind: "message",
        lifecycle: "completed",
        title: "message",
        text: "Done.",
      },
    ],
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

// Mirrors tests/run/run.test.ts writeCuaRunFixture: a live bundle whose actor trace
// declares raw screenshots, which verify judges local_only (RAW_SCREENSHOTS).
export async function writeLocalOnlyRun(cwd: string, runId: string): Promise<void> {
  const trace = rawScreenshotActorTrace();
  const session: CuaLoopResult = {
    status: trace.status,
    completionReason: trace.completionReason,
    reason: trace.reason,
    trace,
  };
  const bundle = buildSingleParticipantBundle({
    verdict: verdictForStatus(session.status),
    actorId: "openai-computer-use",
    appUrl: "http://127.0.0.1:3000/",
    createdAt: "2026-01-01T00:00:00.000Z",
    dryRun: false,
    labId: "serve-safe-proof",
    mission: "Explore the app and stop.",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    resolution: [1440, 960],
    runId,
    screenshots: [],
    session,
    traceArtifactPath: "actor.json",
    source: await buildRunSource({ cwd, humanishSource: "present", packageName: "humanish" }),
  });
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(runDir, "review.json"),
    `${JSON.stringify(bundle.review, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "review.md"),
    `# ${bundle.scenario.title}\n\n- verdict: ${bundle.review.verdict}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "events.ndjson"),
    `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, "actor.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
}
