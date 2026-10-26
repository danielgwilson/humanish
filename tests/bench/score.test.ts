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
  storage: "memory",
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
      const scored = participantsOf(bundle, mission, "memory").map((input) =>
        scoreReport(input, label.arm),
      );
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
        participantsOf(bundle, mission, "memory").map((entry) => entry.facts),
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

describe("the Taskly scorer on the localStorage builds", () => {
  it("counts a lost-on-reload claim as invented on the builds that keep tasks in localStorage", () => {
    for (const arm of ["planted", "clean"] as const) {
      const score = scoreReport(
        participant("Refreshing the page erased the entire list.", { storage: "local" }),
        arm,
      );
      expect(score.invented.map((match) => match.classId)).toEqual(["B10"]);
    }
  });

  it("counts a lost-on-reload analysis finding as invented when any participant's build kept tasks", () => {
    const local = combineFacts([facts({ storage: "local" })], MISSIONS.neutral.text);
    const score = scoreAnalysis(
      {
        analysisId: "analysis-001",
        model: null,
        promptVersion: null,
        summaryText: "",
        findings: [
          {
            id: "f1",
            title: "Refreshing the page erased the entire list",
            summary: "",
            impact: "high",
            confidence: "high",
            observations: [],
          },
        ],
      },
      "clean",
      local,
    );
    expect(score.findings.map((finding) => finding.verdict)).toEqual(["invented"]);
  });
});

describe("the Taskly scorer on analysis wordings of D1 and D5", () => {
  const scored = (title: string, arm: Arm) =>
    scoreAnalysis(
      {
        analysisId: "analysis-synthetic",
        model: null,
        promptVersion: null,
        summaryText: "",
        findings: [
          { id: "f1", title, summary: "", impact: "low", confidence: "high", observations: [] },
        ],
      },
      arm,
      facts(),
    ).findings[0]!;

  it("reads a finding that Save left the row editing as D5, and one about Enter or a reload as another claim", () => {
    // Wordings of D5 from gpt-6-luna, gpt-6.1-sol, gpt-6-astra and Gemini analyses of the
    // 2026-10-21 recordings that the first rubric left unresolved.
    for (const title of [
      "Save left the row in edit mode",
      "Saving the edit left the row in editing mode.",
      "Inline task row remains in edit mode after clicking Save",
      "Edit mode remains active after saving",
      "Inline edit mode remains active after clicking Save",
      "Edited task rows remain stuck in edit mode after saving",
      "The edited task still showed Save after saving.",
      "The edited row still showed a Save button after the participant saved it.",
      "After saving an edit, the row still showed an editing field and Save button.",
      "The participant noticed that Save had not changed back to Edit.",
      "The text was visible after the second Save click, while the input and Save button remained.",
      "The editing state did not visibly end after the second Save click.",
      "The new wording was visible before and after the second Save, while the input and Save button remained.",
      "After the second Save click, the wording was visible but the editing state remained unchanged.",
      "A second attempt displayed the new wording, but Save did not visibly return the row to its normal display.",
      "The participant was unsure because the control still said Save rather than Edit.",
      "Task rename reverted after two Save attempts",
      "The dentist-task edit reverted after repeated Save attempts",
      "Two Save attempts did not retain the edited title",
      "Edited task names are not saved and revert to their original text",
      "Task edits fail to save and revert after subsequent actions",
      "Save button failure and edit reversion",
    ]) {
      expect(scored(title, "planted"), title).toMatchObject({
        verdict: "planted",
        defects: ["D5"],
      });
      expect(scored(title, "clean").classes, title).toContain("D5");
      expect(scored(title, "clean").verdict, title).toBe("invented");
    }
    for (const title of [
      "Enter left the edited task open until Save was clicked",
      "Pressing Enter in the task edit field did not save the edited task",
      "Edits do not persist after a page refresh",
      "The task remains open in edit mode until the user manually clicks the Save button.",
      "Inline task editor lacks a Cancel button",
    ]) {
      expect(scored(title, "clean").classes, title).not.toContain("D5");
    }
  });

  it("reads a finding that Clear completed left the checked rows in place as D1", () => {
    for (const title of [
      "Clear completed produced no visible removal",
      "Clear completed left both checked rows visible",
      "Clear completed attempts left the completed rows visible",
      "Completed tasks remained after repeated clearing attempts",
      "Completed tasks remained after bulk-clear attempts",
    ]) {
      expect(scored(title, "planted"), title).toMatchObject({
        verdict: "planted",
        defects: ["D1"],
      });
    }
  });
});

// Rubric v4. Every wording below is quoted from a 2026-10-24 or 2026-10-25 bench report or
// analysis finding.
describe("the Taskly scorer on an edit lost across a reload", () => {
  const lostEdit = [
    "Laundry edit did not persist after Save and refresh.",
    "The attempted groceries edit did not survive refresh.",
    "The attempted task edit remained open and was absent after reload.",
    "Edited wording reverted after Save and reload.",
    "I tried again, but after reloading, the added words were gone.",
    "After refreshing, the old wording returned.",
    "It stayed in the editing box without confirmation, and after refreshing it was back to Wednesday.",
  ];

  it("reads it as D5 on the builds that keep tasks, where only Save can lose an edit", () => {
    for (const report of lostEdit) {
      const planted = scoreReport(participant(report, { storage: "local" }), "planted");
      expect(planted.detected.D5, report).toBe(true);
      expect(planted.invented, report).toEqual([]);
      const clean = scoreReport(participant(report, { storage: "local" }), "clean");
      expect(
        clean.invented.map((match) => match.classId),
        report,
      ).toEqual(["D5"]);
    }
  });

  it("leaves it to B10 on the memory builds, where a reload loses every task", () => {
    for (const report of [
      "Laundry edit did not persist after Save and refresh.",
      "The attempted groceries edit did not survive refresh.",
    ]) {
      const score = scoreReport(participant(report), "clean");
      expect(
        score.supported.map((match) => match.classId),
        report,
      ).toEqual(["B10"]);
      expect(score.invented, report).toEqual([]);
    }
  });

  it("keeps B10 for every task lost on reload, an edit among them", () => {
    for (const report of [
      "After I refreshed the page, my tasks and edit were gone.",
      "Refreshing the page erased all five tasks, including their completion state and my edit.",
    ]) {
      const score = scoreReport(participant(report, { storage: "local" }), "planted");
      expect(
        score.invented.map((match) => match.classId),
        report,
      ).toEqual(["B10"]);
      expect(score.detected.D5, report).toBe(false);
    }
  });

  it("reads a reload that only reset the selected filter as no lost task", () => {
    const report = "Refreshing reset the filter to All, though the tasks themselves remained.";
    const score = scoreReport(participant(report, { storage: "local" }), "clean");
    expect(score.invented).toEqual([]);
  });
});

describe("the Taskly scorer on Save leaving the row in its editing box", () => {
  it("reads Save that left an editing box or field open as D5", () => {
    for (const report of [
      "I edited groceries to Buy groceries on Tuesday and clicked Save, but it stayed in an editing box.",
      "I tried changing groceries to Buy groceries on Tuesday, but Save left the item in an editing box.",
      "I changed laundry from Tuesday to Saturday and clicked Save, but it stayed in an editing field.",
      "I shortened it using Edit, but clicking Save left the editing box open.",
      "I edited that errand and clicked Save, but the edit box stayed open.",
    ]) {
      expect(scoreReport(participant(report), "planted").detected.D5, report).toBe(true);
    }
  });

  it("does not read an edit field that Save closed, or Enter in an edit field, as D5", () => {
    for (const report of [
      "Enter in the edit field did not finish the edit; I had to Tab to Save and press Enter.",
      "I switched to the pointer, then had to click inside the edit field before typing.",
      "Clicking Edit did not focus the new edit field.",
    ]) {
      const score = scoreReport(participant(report), "clean");
      expect(
        score.invented.map((match) => match.classId),
        report,
      ).not.toContain("D5");
    }
  });
});

describe("the Taskly scorer on a task name cut off mid-word", () => {
  it("reads a cut-off errand or reminder, or a day name cut short, as D2", () => {
    for (const report of [
      "My library reminder appeared cut off at Thursd, without any explanation.",
      "The library errand displayed Tuesda rather than the full Tuesday, making it look cut off.",
      "The library errand ended at Thursd on screen rather than showing the full wording.",
      "Return library books on Wednesday became Return library books on Wednes, with no visible warning.",
    ]) {
      expect(scoreReport(participant(report), "planted").detected.D2, report).toBe(true);
    }
  });

  it("does not read a full day name, a stop in the session or a quoted cut day name alone as D2", () => {
    for (const report of [
      "I changed groceries from Monday to Wednesday and clicked Save, but the editing box stayed open.",
      "Once refreshing made the whole list disappear, I stopped: I wouldn't trust it to remember this week's errands.",
      "Both the initial edit view and the later Completed view showed an edit field reading Return library books on Wednes, with a Save button.",
    ]) {
      expect(scoreReport(participant(report), "planted").detected.D2, report).toBe(false);
    }
  });
});
