// #392: a live run's feedback draft described a different kind of run entirely.
//
// Two halves, pinned separately. The CUA routes never built a feedback candidate, so every live
// browser run fell through to the dry-run template — a draft claiming "no browser behavior was
// exercised" over a run with fifteen screenshots of browser behavior. And the fallback itself was
// mode-blind, so even after candidates exist, a clean live run must still get a draft describing
// THE RUN THAT HAPPENED rather than the dry-run letter.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ActorCapabilities, ActorTrace } from "../src/actor-contract.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import { participantFeedbackCandidates } from "../src/cua-actor-lab.js";
import { draftFeedback } from "../src/feedback.js";
import { runDryRun } from "../src/run.js";

const FAKE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

function fakeSession(
  status: ActorTrace["status"],
  completionReason: ActorTrace["completionReason"],
  reason: string
): CuaLoopResult {
  const trace: ActorTrace = {
    schema: "humanish.actor-trace.v1",
    provider: "fake-cua",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "keyboard-first", traitsApplied: ["accessibility:keyboard_first"], promptDigest: "d1" },
    redaction: { status: "passed", screenshots: "blurred", notes: "test" },
    startedAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-11T00:05:00.000Z",
    durationMs: 300_000,
    status,
    completionReason,
    reason,
    ids: {},
    counts: { turns: 20, actions: 30 },
    items: [],
    capabilities: FAKE_CAPS
  };
  return { status, completionReason, reason, trace };
}

const LANE_BASE = {
  laneId: "power-user",
  streamId: "stream-002",
  personaId: "skeptical-power-user",
  traceArtifactPath: "actors/stream-002.json",
  screenshots: ["screenshots/power-user/turn-17.png"],
  commsArtifactPath: "comms/power-user-thread.json"
};

describe("participantFeedbackCandidates (#392)", () => {
  it("turns a self-reported blocker into a target-app candidate quoting the participant", () => {
    const session = fakeSession(
      "passed",
      "goal_satisfied",
      "Signed up, but the signature step was not keyboard-completable: I could not get focus into the typed-signature entry area and had to use the mouse."
    );
    const candidates = participantFeedbackCandidates({
      runId: "run-1",
      scenarioId: "cua-signup-email-verify",
      adapterId: "signup-email-verify",
      goal: "Create an account and reach the dashboard.",
      substrate: "e2b-desktop",
      lanes: [{ ...LANE_BASE, session }]
    });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.actor).toBe("computer-use");
    expect(candidate.failure_owner).toBe("target-app");
    expect(candidate.summary).toContain("reported friction");
    expect(candidate.actual).toContain("keyboard-completable");
    expect(candidate.evidence.map((item) => item.kind)).toEqual(["trace", "screenshot", "log"]);
    expect(candidate.idempotency_key).toBe("humanish:run-1:power-user:participant-report");
  });

  it("turns abandonment into a candidate — the finding the study paid for", () => {
    const session = fakeSession("abandoned", "gave_up", "gave up: 24 consecutive turns with no material UI action (only screenshot/wait)");
    const candidates = participantFeedbackCandidates({
      runId: "run-2",
      scenarioId: "cua-lab",
      adapterId: "lab",
      goal: "Complete the flow.",
      substrate: "e2b-desktop",
      lanes: [{ ...LANE_BASE, session }]
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.summary).toContain("stopped before completing");
  });

  it("files nothing for a clean pass or a missing session", () => {
    const clean = fakeSession("passed", "goal_satisfied", "Signed up and reached the dashboard.");
    const candidates = participantFeedbackCandidates({
      runId: "run-3",
      scenarioId: "cua-lab",
      adapterId: "lab",
      goal: "Complete the flow.",
      substrate: "e2b-desktop",
      lanes: [{ ...LANE_BASE, session: clean }, { ...LANE_BASE, laneId: "no-session", streamId: "stream-003" }]
    });
    expect(candidates).toHaveLength(0);
  });
});

describe("the live fallback draft describes the run that happened (#392)", () => {
  it("never hands a live bundle the dry-run letter", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-live-draft-"));
    const cwd = path.join(tempRoot, "minimal-app");
    try {
      await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
      await runDryRun({ cwd, dryRun: true, runId: "live-draft-test" });

      // Rewrite the persisted bundle as a LIVE run with a participants tally and no candidates —
      // the exact shape the field failure had (15 screenshots, zero feedbackCandidates).
      const runJsonPath = path.join(cwd, ".humanish", "runs", "live-draft-test", "run.json");
      const bundle = JSON.parse(await readFile(runJsonPath, "utf8"));
      bundle.mode = "live";
      bundle.review.participants = {
        total: 1, reachedGoal: 0, abandoned: 1, ranOut: 0, blocked: 0, harnessFailed: 0, reportedFriction: 1
      };
      await writeFile(runJsonPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const drafted = await draftFeedback(cwd, "live-draft-test");
      expect(drafted.ok).toBe(true);
      const draft = drafted.draft!;
      expect(draft.summary).not.toContain("Dry-run contract proof");
      expect(draft.actual).not.toContain("no browser or product behavior was exercised");
      expect(draft.actor).not.toBe("synthetic-dry-run");
      expect(draft.idempotency_key).toBe("humanish:live-draft-test:live-run-summary");
      // The participants line rides the draft with its denominator intact.
      expect(draft.actual).toContain("0/1 reached the goal");
      expect(draft.actual).toContain("1 gave up");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
