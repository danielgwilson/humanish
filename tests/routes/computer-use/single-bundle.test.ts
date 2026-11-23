import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../../../src/actors/contract.js";
import { buildObserverData } from "../../../src/observer/data.js";
import { buildRunSource } from "../../../src/run/bundle.js";
import { buildSingleParticipantBundle } from "../../../src/routes/computer-use/single-bundle.js";

// A single participant's review summary counts its ending under the status the run judged it, as
// the Observer does: a passed session that never engaged reads as interrupted by its cap, and a
// participant the harness failed reads as a harness failure whatever stop its trace records.

/** A trace that ended as `ending` says, after one turn with no action. */
function traceOf(
  ending: Pick<ActorTrace, "status" | "completionReason" | "stopCause" | "reason">,
): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "openai-responses-cu",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    redaction: { status: "passed", screenshots: "raw", notes: "synthetic test trace" },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:10:00.000Z",
    durationMs: 600_000,
    ...ending,
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
}

/** The bundle of one participant whose session left `trace`, judged with `facts`. */
async function bundleOf(
  trace: ActorTrace,
  facts: { noEngagement?: boolean; sessionError?: string } = {},
) {
  return buildSingleParticipantBundle({
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
    studyId: "single-summary",
    mission: "Add a note, then stop.",
    persona: trace.persona,
    resolution: [1440, 960],
    screenshots: [],
    session: {
      status: trace.status,
      completionReason: trace.completionReason,
      reason: trace.reason,
      trace,
    },
    ...(facts.sessionError === undefined ? {} : { sessionError: facts.sessionError }),
    traceArtifactPath: "actor.json",
    credibility: {
      noEngagement: facts.noEngagement === true,
      selfReportedBlocker: false,
      reportedFriction: false,
    },
    source: await buildRunSource({
      cwd: process.cwd(),
      humanishSource: "present",
      packageName: "humanish",
    }),
  });
}

describe("a single-participant review summary", () => {
  it("counts a passed session with no engagement as interrupted by its session cap", async () => {
    const bundle = await bundleOf(
      traceOf({
        status: "passed",
        completionReason: "goal_satisfied",
        stopCause: "session_cap",
        reason: "The session reached its cap.",
      }),
      { noEngagement: true },
    );
    expect(bundle.review.summary).toBe(
      "1 participant took part: 0/1 recorded completions, 1 interrupted (session cap). Not counted as a pass: the participant took no actions and said nothing. How it ended: The session reached its cap.",
    );
    expect(buildObserverData(bundle).run.participantsLine).toBe(
      "0/1 recorded completions, 1 interrupted (session cap)",
    );
  });

  it("counts a session that ended in a harness error at its time limit by that stop", async () => {
    const bundle = await bundleOf(
      traceOf({
        status: "failed",
        completionReason: "harness_error",
        stopCause: "time_limit",
        reason: "The provider stopped answering at the time limit.",
      }),
    );
    expect(bundle.review.summary).toBe(
      "1 participant took part: 0/1 recorded completions, 1 interrupted (time limit). How it ended: The provider stopped answering at the time limit.",
    );
    expect(buildObserverData(bundle).run.participantsLine).toBe(
      "0/1 recorded completions, 1 interrupted (time limit)",
    );
  });

  it("counts a session the desktop failed under as lost to a harness failure", async () => {
    const bundle = await bundleOf(
      traceOf({
        status: "incomplete",
        completionReason: "budget_reached",
        stopCause: "time_limit",
        reason: "The session reached its time limit.",
      }),
      { sessionError: "The desktop stopped answering." },
    );
    expect(bundle.review.summary).toBe(
      "1 participant took part: 0/1 recorded completions, 1 lost to a harness failure. How it ended: The session reached its time limit.",
    );
    expect(buildObserverData(bundle).run.participantsLine).toBe(
      "0/1 recorded completions, 1 lost to a harness failure",
    );
  });
});
