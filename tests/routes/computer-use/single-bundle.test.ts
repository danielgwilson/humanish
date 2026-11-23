import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../../../src/actors/contract.js";
import { buildObserverData } from "../../../src/observer/data.js";
import { buildRunSource } from "../../../src/run/bundle.js";
import { buildSingleParticipantBundle } from "../../../src/routes/computer-use/single-bundle.js";

// A single participant's review summary counts its ending under the status the run judged it, as
// the Observer does, so a passed session that never engaged reads as interrupted by its cap.

const trace: ActorTrace = {
  schema: ACTOR_TRACE_SCHEMA,
  provider: "openai-responses-cu",
  protocol: "cua-loop",
  lane: "computer-use",
  persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
  redaction: { status: "passed", screenshots: "raw", notes: "synthetic test trace" },
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:10:00.000Z",
  durationMs: 600_000,
  status: "passed",
  completionReason: "goal_satisfied",
  stopCause: "session_cap",
  reason: "The session reached its cap.",
  ids: {},
  counts: { turns: 1, actions: 0, screenshots: 0, reasonings: 0, messages: 0 },
  items: [],
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

describe("a single-participant review summary", () => {
  it("counts a passed session with no engagement as interrupted by its session cap", async () => {
    const bundle = buildSingleParticipantBundle({
      verdict: "fail",
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      subject: { source: "app-url", state: { provenance: "undeclared" } },
      run: {
        runId: "cua-2026-01-01T00-00-00-000Z-00000000",
        mode: "live",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      dryRun: false,
      studyId: "no-engagement",
      mission: "Add a note, then stop.",
      persona: trace.persona,
      resolution: [1440, 960],
      screenshots: [],
      session: {
        status: "passed",
        completionReason: "goal_satisfied",
        reason: trace.reason,
        trace,
      },
      traceArtifactPath: "actor.json",
      credibility: { noEngagement: true, selfReportedBlocker: false, reportedFriction: false },
      source: await buildRunSource({
        cwd: process.cwd(),
        humanishSource: "present",
        packageName: "humanish",
      }),
    });
    expect(bundle.review.summary).toBe(
      "1 participant took part: 0/1 recorded completions, 1 interrupted (session cap). Not counted as a pass: the participant took no actions and said nothing. How it ended: The session reached its cap.",
    );
    expect(buildObserverData(bundle).run.participantsLine).toBe(
      "0/1 recorded completions, 1 interrupted (session cap)",
    );
  });
});
