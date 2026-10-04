import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  analysisInputOf,
  participantsOf,
  type AnalysisArtifact,
  type RunBundle,
} from "../../bench/lib/bundle.js";
import {
  combineFacts,
  scoreAnalysis,
  scoreReport,
  type ParticipantInput,
} from "../../bench/lib/score.js";
import { DEFECT_IDS, type Arm, type EvidenceFacts } from "../../bench/taskly/answer-key.js";
import { MISSIONS } from "../../bench/taskly/missions.js";

const FIXTURES = path.resolve("tests/fixtures/bench/taskly");

interface ParticipantLabel {
  detected: string[];
  falseAssurance?: string[];
  d2Mechanism?: string | null;
  invented?: string[];
  supportedPlanted?: string[];
}

interface Labels {
  runs: Record<
    string,
    { arm: Arm; mission: "neutral" | "walked"; participants: Record<string, ParticipantLabel> }
  >;
  analyses: Record<
    string,
    {
      arm: Arm;
      findings: Record<string, string[]>;
      unresolved: string[];
      d2Mechanism: string | null;
    }
  >;
}

const labels = JSON.parse(readFileSync(path.join(FIXTURES, "labels.json"), "utf8")) as Labels;
const readFixture = <T>(folder: string, runId: string): T =>
  JSON.parse(readFileSync(path.join(FIXTURES, folder, `${runId}.json`), "utf8")) as T;

const facts = (overrides: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
  maxTypedChars: 90,
  providerStall: false,
  failedAction: false,
  personaTraits: [],
  mission: MISSIONS.neutral.text,
  ...overrides,
});

const participant = (report: string, overrides: Partial<EvidenceFacts> = {}): ParticipantInput => ({
  streamId: "stream-001",
  report,
  narration: [],
  facts: facts(overrides),
});

describe("the Taskly scorer on recorded bundles", () => {
  it("has a label for every recorded run", () => {
    const recorded = readdirSync(path.join(FIXTURES, "runs")).map((file) =>
      file.replace(/\.json$/, ""),
    );
    expect(recorded.sort()).toEqual(Object.keys(labels.runs).sort());
  });

  for (const [runId, label] of Object.entries(labels.runs)) {
    it(`agrees with the hand labels for ${runId} (${label.arm})`, () => {
      const bundle = readFixture<RunBundle>("runs", runId);
      const mission = MISSIONS[label.mission].text;
      const scored = participantsOf(bundle, mission).map((input) => scoreReport(input, label.arm));
      expect(scored.map((score) => score.streamId).sort()).toEqual(
        Object.keys(label.participants).sort(),
      );
      for (const score of scored) {
        const expected = label.participants[score.streamId]!;
        const detected = DEFECT_IDS.filter((defect) => score.detected[defect]);
        expect(detected).toEqual(expected.detected);
        expect(score.falseAssurance.map((match) => match.classId)).toEqual(
          expected.falseAssurance ?? [],
        );
        expect(score.invented).toEqual([]);
        if (label.arm === "planted") expect(score.d2Mechanism).toBe(expected.d2Mechanism);
        if (label.arm === "clean") {
          const planted = score.supported.filter((match) => /^D\d$/.test(match.classId));
          expect(planted.map((match) => match.classId)).toEqual(expected.supportedPlanted ?? []);
        }
      }
    });
  }

  for (const [runId, label] of Object.entries(labels.analyses)) {
    it(`maps each analysis finding of ${runId} to its labelled defect`, () => {
      const bundle = readFixture<RunBundle>("runs", runId);
      const artifact = readFixture<AnalysisArtifact>("analyses", runId);
      const input = analysisInputOf(artifact);
      expect(input).not.toBeNull();
      const mission = MISSIONS[labels.runs[runId]!.mission].text;
      const runFacts = combineFacts(
        participantsOf(bundle, mission).map((entry) => entry.facts),
        mission,
      );
      const score = scoreAnalysis(input!, label.arm, runFacts);
      expect(
        Object.fromEntries(score.findings.map((finding) => [finding.id, finding.defects])),
      ).toEqual(label.findings);
      expect(
        score.findings
          .filter((finding) => finding.verdict === "unresolved")
          .map((finding) => finding.id),
      ).toEqual(label.unresolved);
      expect(score.d2Mechanism).toBe(label.d2Mechanism);
      const labelled = new Set(Object.values(label.findings).flat());
      expect(DEFECT_IDS.filter((defect) => score.listed[defect])).toEqual(
        DEFECT_IDS.filter((defect) => labelled.has(defect)),
      );
      expect(score.findings.filter((finding) => finding.verdict === "invented")).toEqual([]);
    });
  }
});

describe("the Taskly scorer on claims the recorded runs never made", () => {
  it("counts a planted-class claim on the clean build as invented", () => {
    const score = scoreReport(
      participant(
        "The filters appeared reversed: Active showed the finished task. The empty list displayed undefined.",
      ),
      "clean",
    );
    expect(score.invented.map((match) => match.classId)).toEqual(["D3", "D4"]);
  });

  it("supports a clean-build truncation claim only when the participant typed past the 120-character limit", () => {
    const report = "My long task got cut off without any warning.";
    expect(scoreReport(participant(report, { maxTypedChars: 100 }), "clean").invented).toHaveLength(
      1,
    );
    const typedPast = scoreReport(participant(report, { maxTypedChars: 150 }), "clean");
    expect(typedPast.invented).toEqual([]);
    expect(typedPast.supported.map((match) => match.classId)).toEqual(["D2"]);
  });

  it("counts a broken claim about a working control as invented on either build", () => {
    for (const arm of ["planted", "clean"] as const) {
      const score = scoreReport(
        participant("Clicking Delete did nothing, so the task stayed."),
        arm,
      );
      expect(score.invented.map((match) => match.classId)).toEqual(["X1"]);
    }
  });

  it("holds Enter-does-not-save true on the clean build and false on the planted build", () => {
    const report = "Enter does not save a rename; I had to click Save.";
    expect(
      scoreReport(participant(report), "clean").supported.map((match) => match.classId),
    ).toEqual(["B1"]);
    expect(
      scoreReport(participant(report), "planted").invented.map((match) => match.classId),
    ).toEqual(["B1"]);
  });

  it("flags a working-filter statement on the planted build as false assurance", () => {
    const score = scoreReport(
      participant("Active showed only the two unfinished tasks."),
      "planted",
    );
    expect(score.detected.D3).toBe(false);
    expect(score.falseAssurance.map((match) => match.classId)).toEqual(["D3"]);
  });

  it("does not count a negated assurance", () => {
    const score = scoreReport(participant("Clear completed never worked for me."), "planted");
    expect(score.falseAssurance).toEqual([]);
    expect(
      scoreReport(participant("Clear completed worked."), "planted").falseAssurance,
    ).toHaveLength(1);
  });

  it("attributes a slowness claim to the harness only when the trace shows a provider stall", () => {
    const report = "The app felt slow after I added the second task.";
    const stalled = scoreReport(participant(report, { providerStall: true }), "clean");
    expect(stalled.harness.map((match) => match.classId)).toEqual(["H1"]);
    const quiet = scoreReport(participant(report), "clean");
    expect(quiet.harness).toEqual([]);
    expect(quiet.unresolved).toHaveLength(0);
    const unexplained = scoreReport(
      participant("The app felt slow and the layout was confusing."),
      "clean",
    );
    expect(unexplained.unresolved).toHaveLength(1);
  });

  it("leaves problem language that matches no claim class unresolved", () => {
    const score = scoreReport(
      participant("The colors were confusing on the settings page."),
      "clean",
    );
    expect(score.unresolved).toHaveLength(1);
    expect(score.invented).toEqual([]);
  });

  it("supports a lost-on-reload claim on both builds, which keep tasks in memory only", () => {
    for (const report of [
      "Refreshing the page erased the entire list.",
      "Three remaining tasks were absent from the list after refresh.",
      "The list did not survive a normal page refresh.",
    ]) {
      for (const arm of ["planted", "clean"] as const) {
        expect(
          scoreReport(participant(report), arm).supported.map((match) => match.classId),
        ).toEqual(["B10"]);
      }
    }
  });

  it("reads an analysis title about Enter leaving an edit open as the clean build's Enter behavior", () => {
    const score = scoreReport(
      participant("Enter left an edit open; clicking Save completed it."),
      "clean",
    );
    expect(score.supported.map((match) => match.classId)).toEqual(["B1"]);
  });

  it("reads reassurance and negated truncation as no problem", () => {
    const score = scoreReport(
      participant(
        "The long task wrapped over four lines without being cut off. No issues blocked me, and I encountered no blockers or unclear error output.",
      ),
      "clean",
    );
    expect(score.unresolved).toEqual([]);
    expect(score.invented).toEqual([]);
  });

  it("separates a data-loss reading of D2 from a display reading", () => {
    const loss = scoreReport(
      participant(
        "The long task was cut off. Opening Edit confirmed only the first 30 characters were kept.",
      ),
      "planted",
    );
    const display = scoreReport(
      participant("The long task was cut off visually instead of wrapping."),
      "planted",
    );
    expect(loss.d2Mechanism).toBe("data_loss");
    expect(display.d2Mechanism).toBe("display");
  });
});
