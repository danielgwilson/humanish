// The findings projection and its text, over the analysis records committed in the repo: two
// published live runs (site/public/runs) and the synthetic artifact the analysis tests use.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AutomaticAnalysisView } from "../../src/analysis/job.js";
import type { AnalysisArtifact, LoadedAnalysis } from "../../src/analysis/types.js";
import { analysisFindings, ANALYSIS_FINDINGS_SCHEMA } from "../../src/cli/findings.js";
import { formatFindings, formatFindingsSummary } from "../../src/cli/findings-text.js";
import { syntheticArtifact } from "../analysis/fixtures.js";

const published = (name: string): LoadedAnalysis =>
  JSON.parse(
    readFileSync(
      new URL(`../../site/public/runs/${name}/observer/study-analysis.json`, import.meta.url),
      "utf8",
    ),
  ) as LoadedAnalysis;

function source(loaded: LoadedAnalysis, mode: string | undefined = "live") {
  const runId = loaded.analysis?.runId ?? "synthetic-study";
  return { runId, mode, runRoot: `.humanish/runs/${runId}`, loaded, cwdFlag: "" };
}

const ready = (analysis: AnalysisArtifact): LoadedAnalysis => ({
  state: "ready",
  analysis,
  corrections: [],
  warnings: [],
});

const none = (automatic?: AutomaticAnalysisView): LoadedAnalysis => ({
  state: "none",
  analysis: null,
  corrections: [],
  warnings: [],
  ...(automatic === undefined ? {} : { automatic }),
});

const job = (
  state: AutomaticAnalysisView["state"],
  reason: string | null = null,
): AutomaticAnalysisView => ({
  state,
  analysisId: null,
  reason,
  updatedAt: "2026-10-04T00:00:00.000Z",
});

const overCap: AutomaticAnalysisView = {
  ...job("skipped", "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED"),
  admission: { expectedCostUsd: 2.952275, worstCaseCostUsd: 3.360675, maxCostUsd: 3 },
};

describe("a ready analysis", () => {
  it("projects every finding with its participants, evidence moments and capture files", () => {
    const view = analysisFindings(source(published("try-live")));
    const runRoot = ".humanish/runs/cua-2026-10-03T10-43-07-890Z-833df699";
    expect(view).toMatchObject({
      schema: ANALYSIS_FINDINGS_SCHEMA,
      state: "ready",
      next: null,
      status: "complete",
      provider: "openai",
      model: "gpt-6-astra",
      estimatedCostUsd: 0.48348,
      runPath: runRoot,
    });
    expect(
      view.findings.map((finding) => [
        finding.id,
        finding.impact,
        finding.confidence,
        finding.recovery,
      ]),
    ).toEqual([
      ["F1", "friction", "high", "not_observed"],
      ["F2", "friction", "high", "recovered"],
      ["F3", "friction", "high", "recovered"],
    ]);
    const first = view.findings[0]!;
    expect(first.affected).toEqual([{ streamId: "stream-001", label: "lane-01 · browser" }]);
    expect(first.exposedCount).toBe(1);
    // Each cited item once, in citation order, with how the observations used it.
    expect(
      first.evidence.map((entry) => [entry.id, entry.frame, entry.elapsedMs, entry.capture]),
    ).toEqual([
      ["e000020", 5, 23613, `${runRoot}/screenshots/turn-05.jpg`],
      ["e000029", 7, 34288, `${runRoot}/screenshots/turn-07.jpg`],
      ["e000021", 5, 27105, null],
    ]);
    expect(view.path).toBe(
      `${runRoot}/analysis/analysis-4cd2555b-19fe-49e4-a693-3edd70a7f236/analysis.json`,
    );
  });

  it("prints each finding's title, impact, confidence, recovery, participants, frames and captures", () => {
    const lines = formatFindings(analysisFindings(source(published("try-live"))));
    expect(lines[0]).toBe(
      "findings: 3 from analysis analysis-4cd2555b-19fe-49e4-a693-3edd70a7f236 (complete, openai gpt-6-astra, estimated $0.48)",
    );
    const f1 = lines.indexOf("F1 The second table partially obscured the first on the canvas");
    expect(lines.slice(f1 + 1, f1 + 2)).toEqual([
      "   impact: friction · confidence: high · recovery: no recovery observed",
    ]);
    expect(lines.slice(f1 + 3, f1 + 6)).toEqual([
      "   affected: 1 of 1 exposed participant",
      "   - lane-01 · browser: frame 5 at +0:23, frame 7 at +0:34",
      "   captures: screenshots/turn-05.jpg, screenshots/turn-07.jpg",
    ]);
    expect(lines[f1 + 6]).toMatch(/^ {3}next step: \S/);
    expect(lines).toContain("limitations:");
    expect(lines.at(-1)).toBe(
      "analysis: .humanish/runs/cua-2026-10-03T10-43-07-890Z-833df699/analysis/analysis-4cd2555b-19fe-49e4-a693-3edd70a7f236/analysis.json",
    );
  });

  it("groups a multi-participant finding's moments by participant", () => {
    const view = analysisFindings(source(published("lobby-0927")));
    expect(view.status).toBe("partial");
    expect(view.findings).toHaveLength(7);
    const lines = formatFindings(view);
    const f1 = lines.findIndex((line) => line.startsWith("F1 "));
    expect(lines[f1 + 1]).toBe(
      "   impact: blocked task · confidence: high · recovery: recovery unknown",
    );
    expect(lines[f1 + 3]).toMatch(/^ {3}affected: 3 of \d+ exposed participants$/);
    const participantLines = lines.slice(f1 + 4).filter((line) => line.startsWith("   - "));
    expect(participantLines.length).toBeGreaterThanOrEqual(3);
    for (const line of participantLines.slice(0, 3)) expect(line).toMatch(/: frame \d+/);
  });

  it("summarizes at most three findings, one line each, with the command for all of them", () => {
    const view = analysisFindings(source(published("lobby-0927")));
    const lines = formatFindingsSummary(view, "humanish review --run lobby");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("findings: 7");
    expect(lines[1]).toMatch(/^- F1 blocked task, high confidence, recovery unknown: \S/);
    expect(lines[4]).toBe("- and 4 more findings");
    expect(lines[5]).toBe("all findings: humanish review --run lobby");
  });

  it("carries the latest human review note on a finding", () => {
    const analysis = syntheticArtifact();
    const loaded: LoadedAnalysis = {
      state: "ready",
      analysis,
      corrections: [
        {
          schema: "humanish.study-analysis-correction.v1",
          id: "correction-1",
          analysisId: analysis.id,
          analysisSha256: "c".repeat(64),
          findingId: "finding-1",
          findingSha256: "d".repeat(64),
          createdAt: "2026-09-01T00:03:00.000Z",
          status: "amended",
          reason: "The claim was too broad.",
          replacementClaim: "Creation stalled once.",
        },
      ],
      warnings: [],
    };
    const view = analysisFindings(source(loaded));
    expect(view.findings[0]!.correction).toEqual({
      status: "amended",
      reason: "The claim was too broad.",
      replacementClaim: "Creation stalled once.",
    });
    const lines = formatFindings(view);
    expect(lines).toContain(
      "   human review: amended, The claim was too broad. Amended claim: Creation stalled once.",
    );
    // The headline and experience describe the claim the reviewer replaced.
    const f1 = lines.indexOf("finding-1 Creation stalled once.");
    expect(lines[f1 + 1]).toBe(
      "   Corrected in human review. The reviewer's claim replaces the original headline and account.",
    );
    expect(lines).not.toContain("finding-1 The participant could not create an item.");
    expect(lines.join("\n")).not.toContain("They were trying to add an item.");
    expect(formatFindingsSummary(view, "humanish review")[1]).toBe(
      "- finding-1 Creation stalled once. (corrected in human review)",
    );
  });

  it("marks findings stale when the run changed after the analysis, and names the command to redo it", () => {
    const loaded: LoadedAnalysis = {
      state: "stale",
      analysis: syntheticArtifact(),
      corrections: [],
      warnings: ["ANALYSIS_SOURCE_CHANGED"],
    };
    const view = analysisFindings(source(loaded));
    expect(view).toMatchObject({
      state: "stale",
      reason: "ANALYSIS_SOURCE_CHANGED",
      next: "humanish analyze --run synthetic-study --max-cost 3",
    });
    expect(view.findings).toHaveLength(1);
    expect(formatFindingsSummary(view, "humanish review --run synthetic-study")[0]).toBe(
      "findings: 1 (stale)",
    );
  });
});

describe("headlines and design findings", () => {
  it("leads each finding with its headline and experience, with its title and evidence beneath", () => {
    const view = analysisFindings(source(ready(syntheticArtifact())));
    expect(view.findings[0]).toMatchObject({
      headline: "The participant could not create an item.",
      experience:
        "They were trying to add an item. The create step did not finish, and they said they could not create it.",
      title: "Item creation was blocked",
    });
    const lines = formatFindings(view);
    const f1 = lines.indexOf("finding-1 The participant could not create an item.");
    expect(lines.slice(f1 + 1, f1 + 5)).toEqual([
      "   They were trying to add an item. The create step did not finish, and they said they could not create it.",
      "   evidence: Item creation was blocked",
      "   impact: blocked task · confidence: medium · recovery: no recovery observed",
      "   The participant could not create an item.",
    ]);
    expect(formatFindingsSummary(view, "humanish review")[1]).toBe(
      "- finding-1 The participant could not create an item. (blocked task, medium confidence, no recovery observed)",
    );
  });

  it("lists design findings most severe first, each with its screen, reasons and captures", () => {
    const analysis = syntheticArtifact();
    analysis.result!.designFindings!.push({
      ...analysis.result!.designFindings![0]!,
      id: "D2",
      headline: "The save button is cut off at the bottom of the window.",
      severity: "major",
      confidence: "high",
    });
    const view = analysisFindings(source(ready(analysis)));
    expect(view.designFindings?.map((finding) => [finding.id, finding.severity])).toEqual([
      ["D2", "major"],
      ["D1", "moderate"],
    ]);
    expect(view.designFindings![1]).toEqual({
      id: "D1",
      headline: "The create button is hard to find.",
      screen: "Item list",
      notice: "The create button is small and sits apart from the list it adds to.",
      whyItMatters: "A person adding an item may not see where to start.",
      suggestion: "Put the create button above the list and give it a text label.",
      severity: "moderate",
      confidence: "medium",
      seenBy: [{ streamId: "participant-a", label: "Participant A" }],
      evidence: [
        {
          id: "e000001",
          streamId: "participant-a",
          kind: "screenshot",
          frame: 0,
          elapsedMs: null,
          at: null,
          capture: ".humanish/runs/synthetic-study/captures/frame.png",
        },
      ],
    });
    const lines = formatFindings(view);
    const design = lines.indexOf("design findings: 2, most severe first");
    expect(design).toBeGreaterThan(lines.findIndex((line) => line.startsWith("finding-1 ")));
    expect(lines.slice(design + 1, design + 3)).toEqual([
      "D2 major: The save button is cut off at the bottom of the window.",
      "   screen: Item list",
    ]);
    expect(lines.slice(design + 9, design + 16)).toEqual([
      "D1 moderate: The create button is hard to find.",
      "   screen: Item list",
      "   notice: The create button is small and sits apart from the list it adds to.",
      "   why it matters: A person adding an item may not see where to start.",
      "   suggestion: Put the create button above the list and give it a text label.",
      "   seen by: Participant A · confidence: medium",
      "   captures: captures/frame.png",
    ]);
    expect(formatFindingsSummary(view, "humanish review").slice(2)).toEqual([
      "design findings: 2",
      "- D2 major: The save button is cut off at the bottom of the window.",
      "- D1 moderate: The create button is hard to find.",
      "all findings: humanish review",
    ]);
  });

  it("prints a headline without an experience line when the experience is missing", () => {
    const analysis = syntheticArtifact();
    delete analysis.result!.findings[0]!.experience;
    const lines = formatFindings(analysisFindings(source(ready(analysis))));
    const f1 = lines.indexOf("finding-1 The participant could not create an item.");
    expect(lines[f1 + 1]).toBe("   evidence: Item creation was blocked");
    expect(lines).not.toContain("   null");
  });

  it("says when the design review found nothing in the captures", () => {
    const analysis = syntheticArtifact();
    analysis.result!.designFindings = [];
    const view = analysisFindings(source(ready(analysis)));
    expect(view.designFindings).toEqual([]);
    expect(formatFindings(view)).toContain("design findings: none in the reviewed captures");
    expect(formatFindingsSummary(view, "humanish review")).toContain("design findings: none");
  });

  it("prints an analysis written before headlines and design findings by title and summary", () => {
    const analysis = syntheticArtifact();
    delete analysis.result!.findings[0]!.headline;
    delete analysis.result!.findings[0]!.experience;
    delete analysis.result!.designFindings;
    const view = analysisFindings(source(ready(analysis)));
    expect(view.findings[0]).toMatchObject({ headline: null, experience: null });
    expect(view.designFindings).toBeNull();
    const lines = formatFindings(view);
    const f1 = lines.indexOf("finding-1 Item creation was blocked");
    expect(lines.slice(f1 + 1, f1 + 3)).toEqual([
      "   impact: blocked task · confidence: medium · recovery: no recovery observed",
      "   The participant could not create an item.",
    ]);
    expect(lines.some((line) => line.startsWith("design findings"))).toBe(false);
    expect(formatFindingsSummary(view, "humanish review")).toEqual([
      "findings: 1",
      "- finding-1 blocked task, medium confidence, no recovery observed: Item creation was blocked",
      "all findings: humanish review",
    ]);
  });
});

describe("a run without findings", () => {
  const cases: Array<[string, LoadedAnalysis, string | undefined, string, string | null]> = [
    ["a dry run with no live study to name", none(), "dry-run", "dry_run", "humanish study list"],
    [
      "a running automatic analysis",
      none(job("running")),
      "live",
      "running",
      "humanish review --run synthetic-study",
    ],
    [
      "a skipped automatic analysis",
      none(job("skipped", "AUTOMATIC_ANALYSIS_KEY_MISSING")),
      "live",
      "skipped",
      "humanish analyze --run synthetic-study --max-cost 3",
    ],
    [
      "an analysis refused at admission",
      none(job("skipped", "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED")),
      "live",
      "skipped",
      "humanish analyze --run synthetic-study --max-cost 3 --dry-run",
    ],
    [
      "an analysis refused for its cost",
      none(overCap),
      "live",
      "skipped",
      "humanish analyze --run synthetic-study --max-cost 4",
    ],
    [
      "a run with no participant evidence",
      none(job("skipped", "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE")),
      "live",
      "skipped",
      null,
    ],
    [
      "a Codex analyst that could not run",
      none(job("failed", "AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE")),
      "live",
      "failed",
      "humanish analyze --run synthetic-study --provider codex",
    ],
    [
      "an unknown automatic outcome",
      none(job("unknown", "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN")),
      "live",
      "unavailable",
      "humanish analyze list --run synthetic-study",
    ],
    [
      "a live run never analyzed",
      none(),
      "live",
      "none",
      "humanish analyze --run synthetic-study --max-cost 3",
    ],
  ];

  it.each(cases)(
    "says what happened to %s and how to get findings",
    (_name, loaded, mode, state, next) => {
      const view = analysisFindings(source(loaded, mode));
      expect(view).toMatchObject({ state, next, findings: [], analysisId: null });
      expect(view.message).not.toMatch(/AUTOMATIC_ANALYSIS_/);
      const lines = formatFindings(view);
      expect(lines[0]).toBe(`findings: none. ${view.message}`);
      expect(lines.slice(1)).toEqual(next === null ? [] : [`next: ${next}`]);
    },
  );

  it("says what an analysis refused for its cost would cost", () => {
    const { message } = analysisFindings(source(none(overCap)));
    expect(message).toContain("$2.95");
    expect(message).toContain("$3.36");
    expect(message).toContain("$3 cap");
  });

  it.each([
    [
      "its own study, whose file runs live",
      { run: "try-live", id: "try-live" },
      "Findings come from live runs: the next command runs try-live live.",
    ],
    [
      "a study it ran by path",
      { run: "studies/checkout.yaml", id: "checkout" },
      "Findings come from live runs: the next command runs checkout live.",
    ],
    [
      "its own study once its file is set live",
      { run: "cua-browser", id: "cua-browser", setLiveIn: "humanish/studies/cua-browser.yaml" },
      "Findings come from live runs: set mode: live in humanish/studies/cua-browser.yaml, then run the next command.",
    ],
  ])("names the live run after a dry run of %s", (_name, liveStudy, tail) => {
    const view = analysisFindings({ ...source(none(), "dry-run"), liveStudy });
    expect(view).toMatchObject({ state: "dry_run", next: `humanish run ${liveStudy.run}` });
    expect(view.message).toBe(
      `This is a dry run: no participant used the product, so there is nothing to analyze. ${tail}`,
    );
  });

  it("names the failed attempt's code and retries with the same analyst", () => {
    const failed: AnalysisArtifact = {
      ...syntheticArtifact(),
      provider: "codex",
      status: "failed",
      result: null,
      error: "analysis_codex_turn_failed",
    };
    const view = analysisFindings(
      source({
        state: "invalid",
        analysis: failed,
        corrections: [],
        warnings: ["ANALYSIS_FAILED"],
      }),
    );
    expect(view).toMatchObject({
      state: "failed",
      reason: "analysis_codex_turn_failed",
      next: "humanish analyze --run synthetic-study --provider codex",
    });
    expect(view.message).toContain("analysis-1");
  });

  it("withholds analysis text that matches a sensitive pattern", () => {
    const analysis = syntheticArtifact();
    analysis.result!.findings[0]!.title = `Saw key ${"sk-" + "syntheticvalue1234567890abcdef"}`;
    const view = analysisFindings(
      source({ state: "ready", analysis, corrections: [], warnings: [] }),
    );
    expect(view).toMatchObject({
      state: "unavailable",
      reason: "ANALYSIS_SENSITIVE_TEXT_QUARANTINED",
      findings: [],
    });
    expect(JSON.stringify(view)).not.toContain("syntheticvalue");
  });
});
