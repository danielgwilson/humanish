import { describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import liveBundle from "./golden/labs/live.json" with { type: "json" };
import { cuaGoalSource, CUA_COMPLETION_NOTE } from "../src/actor-goal-source.js";
import { buildObserverData, withObserverEndings } from "../src/observer-data.js";
import { formatParticipantOutcomes, participantOutcomeDetails, readReview, runDryRun, tallyParticipantOutcomes, withCuaReviewProvenance, type RunBundle } from "../src/run.js";

function bundle(): RunBundle {
  return structuredClone(liveBundle) as unknown as RunBundle;
}
function conditionTrace() {
  const trace = bundle().streams[0]!.actor!;
  trace.items.push({ id: "observed-stop", kind: "notice", lifecycle: "completed", status: "matched", title: "stopWhen matched: saved-record", text: "Harness stop condition matched the declared saved-record rule." });
  return trace;
}

describe("computer-use completion provenance", () => {
  it("labels a natural participant endpoint without trusting its success narrative or changing the saved outcome", () => {
    const run = bundle();
    const before = structuredClone(run);
    const review = withCuaReviewProvenance(run.review, run.streams);
    expect(review.verdict).toBe("pass");
    expect(review.participants).toEqual(run.review.participants);
    expect(review.summary).toContain("Run gate: pass. Participants: 1/1 reported reaching the goal.");
    expect(review.summary).toContain(run.review.summary);
    expect(review.gaps).toContain(CUA_COMPLETION_NOTE);
    expect(run).toEqual(before);
    const observer = buildObserverData(run);
    expect(observer.streams[0]!.status).toBe("passed");
    expect(observer.streams[0]!.statusLabel).toBe("Reported complete");
    expect(observer.run.participantsLine).toBe("1/1 reported reaching the goal");
    expect(observer.run.knownGaps).toContain(CUA_COMPLETION_NOTE);
  });

  it.each(["stopWhen matched: saved-record", "dwell window complete"])("keeps a recorded %s distinct from participant claims", (title) => {
    const run = bundle();
    run.streams[0]!.actor = conditionTrace();
    run.streams[0]!.actor!.items.at(-1)!.title = title;
    expect(cuaGoalSource(run.streams[0]!.actor)).toBe("condition_matched");
    const observer = buildObserverData(run);
    expect(observer.run.participantsLine).toBe("1/1 met a recorded completion condition");
    expect(observer.streams[0]!.statusLabel).toBe("Condition matched");
    expect(withCuaReviewProvenance(run.review, run.streams).summary).not.toContain("reported reaching");
  });

  it("does not promote a quoted condition or an unfinished dwell to condition evidence", () => {
    const trace = bundle().streams[0]!.actor!;
    trace.items.push({ id: "report", kind: "message", lifecycle: "completed", status: "matched", title: "stopWhen matched: saved-record" });
    trace.items.push({ id: "dwell", kind: "notice", lifecycle: "completed", status: "ok", title: "dwell window complete" });
    expect(cuaGoalSource(trace)).toBe("participant_report");
  });

  it("keeps mixed and incomplete provenance attached to the original denominator", () => {
    const traces = [bundle().streams[0]!, { actor: conditionTrace() }];
    const outcomes = tallyParticipantOutcomes(["passed", "passed", "abandoned"]);
    expect(formatParticipantOutcomes(outcomes, participantOutcomeDetails(traces))).toBe("2/3 recorded completions (1 participant-reported, 1 condition-matched), 1 gave up");
    expect(formatParticipantOutcomes(outcomes, participantOutcomeDetails(traces.slice(0, 1)))).toBe("2/3 recorded completions (completion source unavailable), 1 gave up");
  });

  it.each([undefined, null, [], [null], [{}], [[]], [{ kind: "message", title: "Done" }]])("treats missing or malformed legacy CUA items as unavailable (%j)", (items) => {
    const trace = { ...bundle().streams[0]!.actor!, items };
    expect(cuaGoalSource(trace)).toBe("unavailable");
    const text = formatParticipantOutcomes(tallyParticipantOutcomes(["passed"]), participantOutcomeDetails([{ actor: trace }]));
    expect(text).toContain("1 other or unavailable source");
    expect(text).not.toContain("reported reaching");
  });

  it.each(["completionReason", "protocol", "lane"])("marks recognized CUA with missing %s as source unavailable", (field) => {
    const trace = { ...bundle().streams[0]!.actor! } as Record<string, unknown>;
    delete trace[field];
    expect(cuaGoalSource(trace)).toBe("unavailable");
    expect(cuaGoalSource({ ...trace, completionReason: "unknown_legacy_value" })).toBe("unavailable");
  });

  it("keeps rerun and adapter findings while replacing the old unqualified count idempotently", () => {
    const run = bundle();
    run.review.summary = "Rerun from previous-run: 1/1 reached the goal. Adapter check: output differs.";
    run.review.verdict = "fail";
    const next = withCuaReviewProvenance(run.review, run.streams);
    expect(next.summary).toContain("Run gate: fail.");
    expect(next.summary).toContain("Rerun from previous-run: 1/1 reported reaching the goal. Adapter check: output differs.");
    expect(next.summary).not.toContain("1/1 reached the goal");
    expect(withCuaReviewProvenance(next, run.streams)).toEqual(next);
  });

  it("preserves original summaries containing the projection marker as ordinary text", () => {
    const run = bundle();
    run.review.summary = "Adapter important finding. Recorded summary: participant mentioned a missing control.";
    const next = withCuaReviewProvenance(run.review, run.streams);
    expect(next.summary).toContain(run.review.summary);
    expect(withCuaReviewProvenance(next, run.streams)).toEqual(next);
  });

  it.each([undefined, "unknown_legacy_status", "incomplete", "failed", "blocked", "abandoned", "timed_out"])("keeps a recorded completion conservative when recognized CUA status is %j", (status) => {
    const run = bundle();
    (run.streams[0]!.actor! as unknown as Record<string, unknown>).status = status;
    const original = structuredClone(run);
    const projected = buildObserverData(run);
    expect(projected.streams[0]!.statusLabel).toBe("Completion source unavailable");
    expect(projected.run.participantsLine).toMatch(/other or unavailable source|completion source unavailable/);
    expect(withCuaReviewProvenance(run.review, run.streams).summary).not.toContain("1/1 reached the goal");
    expect(run).toEqual(original);
  });

  it("refreshes legacy Observer labels without rewriting the original snapshot", () => {
    const old = buildObserverData(bundle());
    old.run.participantsLine = "1/1 reached the goal";
    old.run.knownGaps = [];
    old.streams[0]!.statusLabel = "Passed";
    const original = structuredClone(old);
    expect(withObserverEndings(old).run.participantsLine).toBe("1/1 reported reaching the goal");
    expect(withObserverEndings(old).streams[0]!.statusLabel).toBe("Reported complete");
    expect(withObserverEndings(old).run.knownGaps).toContain(CUA_COMPLETION_NOTE);
    expect(old).toEqual(original);
  });

  it("preserves deterministic and unrelated actor completion without labeling it participant-reported", () => {
    const run = bundle();
    run.streams[0]!.actor!.lane = "scripted-browser";
    run.streams[0]!.actor!.protocol = "scripted-steps";
    const original = structuredClone(run.review);
    expect(cuaGoalSource(run.streams[0]!.actor)).toBeUndefined();
    expect(withCuaReviewProvenance(run.review, run.streams)).toEqual(original);
    expect(buildObserverData(run).run.participantsLine).toBe("1/1 reached the goal");
    expect(buildObserverData(run).streams[0]!.statusLabel).toBe("Passed");
  });

  it("re-reads legacy review provenance without modifying either original file, including incomplete actor detail", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "humanish-outcome-review-"));
    const cwd = path.join(temp, "app");
    try {
      await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
      await runDryRun({ cwd, dryRun: true, runId: "review-source-test" });
      const root = path.join(cwd, ".humanish/runs/review-source-test");
      const raw = JSON.parse(await readFile(path.join(root, "run.json"), "utf8"));
      const review = { ...raw.review, participants: tallyParticipantOutcomes(["passed"]), summary: "1/1 reached the goal" };
      const originalReview = JSON.stringify(review);
      await writeFile(path.join(root, "review.json"), originalReview);
      for (const items of [[{ id: "message", kind: "message", lifecycle: "completed", title: "Done" }], undefined, [null]]) {
        raw.streams[0].actor = { lane: "computer-use", protocol: "cua-loop", status: "passed", completionReason: "goal_satisfied", items };
        const originalRun = JSON.stringify(raw);
        await writeFile(path.join(root, "run.json"), originalRun);
        const result = await readReview(cwd, "review-source-test");
        expect("summary" in result).toBe(true);
        if ("summary" in result) {
          expect(result.summary).toContain(Array.isArray(items) && items[0] !== null ? "1/1 reported reaching the goal" : "other or unavailable source");
        }
        expect(await readFile(path.join(root, "review.json"), "utf8")).toBe(originalReview);
        expect(await readFile(path.join(root, "run.json"), "utf8")).toBe(originalRun);
      }
      await writeFile(path.join(root, "run.json"), "{invalid");
      await expect(readReview(cwd, "review-source-test")).resolves.toMatchObject({ ok: false });
      await rm(path.join(root, "run.json"));
      await expect(readReview(cwd, "review-source-test")).resolves.toMatchObject({ ok: false });
      expect(await readFile(path.join(root, "review.json"), "utf8")).toBe(originalReview);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
