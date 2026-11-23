// What `run --json` reports for each participant: `status` is how its session ended and
// `judgedStatus` is what the run counts it as.

import { describe, expect, it } from "vitest";

import liveBundle from "../../golden/labs/live.json" with { type: "json" };
import type { ActorSessionResult, ActorTrace } from "../../../src/actors/contract.js";
import { toParticipantResult } from "../../../src/routes/computer-use/participant-execution.js";
import { participantRunsAndPlan } from "../../../src/routes/computer-use/participant-runs.js";
import { planComputerUseStudy } from "../../../src/routes/computer-use/plan.js";
import type { ParticipantRunOutcome } from "../../../src/routes/computer-use/types.js";
import { parseStudy } from "../../../src/study/config.js";
import { concurrentSandboxes, sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";
import { lab } from "../../admission/fixtures.js";

const SUBJECT = { source: "app-url" as const, state: { provenance: "undeclared" as const } };

function participant() {
  const parsed = parseStudy(lab("cuAppUrl", { mode: "live", participants: [{ id: "p1" }] }));
  if (!parsed.ok) throw new Error(parsed.error.message);
  const planned = planComputerUseStudy(parsed.config, {
    dryRun: false,
    sandboxCeiling: sandboxCeiling({}),
    concurrentSandboxes: concurrentSandboxes({}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return participantRunsAndPlan(planned.plan).runs[0]!;
}

/** A session that ended as `status`, with the recorded live trace. */
function session(status: ActorSessionResult["status"]): ActorSessionResult {
  const trace = structuredClone(liveBundle.streams[0]!.actor) as unknown as ActorTrace;
  return {
    status,
    completionReason: status === "passed" ? "goal_satisfied" : "budget_reached",
    reason: "The save button never enabled.",
    trace: { ...trace, status },
  };
}

function outcome(patch: Partial<ParticipantRunOutcome>): ParticipantRunOutcome {
  return {
    spec: participant(),
    killed: true,
    streamUrlPresent: true,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    noEngagement: false,
    selfReportedBlocker: false,
    reportedFriction: false,
    harnessError: false,
    ...patch,
  };
}

function statuses(result: ReturnType<typeof toParticipantResult>) {
  return { status: result.status, judgedStatus: result.judgedStatus, ok: result.ok };
}

describe("a computer-use participant's status in the study result", () => {
  it.each<[string, Partial<ParticipantRunOutcome>, ReturnType<typeof statuses>]>([
    [
      "a passed session",
      { session: session("passed") },
      { status: "passed", judgedStatus: "passed", ok: true },
    ],
    [
      "a passed session whose closing message reports a blocker",
      { session: session("passed"), selfReportedBlocker: true },
      { status: "passed", judgedStatus: "blocked", ok: false },
    ],
    [
      "a passed session with no engagement",
      { session: session("passed"), noEngagement: true },
      { status: "passed", judgedStatus: "incomplete", ok: false },
    ],
    [
      "a session the desktop failed under",
      {
        session: session("incomplete"),
        sessionError: "The desktop stopped answering.",
        harnessError: true,
      },
      { status: "incomplete", judgedStatus: "failed", ok: false },
    ],
    [
      "a harness failure before any session",
      { sessionError: "The desktop did not start.", harnessError: true },
      { status: "failed", judgedStatus: "failed", ok: false },
    ],
    [
      "a participant the study budget skipped",
      { skippedReason: "skipped: the study budget was spent before it started" },
      { status: "blocked", judgedStatus: "blocked", ok: false },
    ],
  ])("keeps how %s ended and adds what the run counts it as", (_, patch, expected) => {
    expect(statuses(toParticipantResult(participant(), outcome(patch), SUBJECT, false))).toEqual(
      expected,
    );
  });

  it("has no judged status for a dry-run participant", () => {
    const result = toParticipantResult(participant(), undefined, SUBJECT, true);
    expect(statuses(result)).toEqual({
      status: "contract_proof_only",
      judgedStatus: undefined,
      ok: true,
    });
    expect(result).not.toHaveProperty("judgedStatus");
  });
});
