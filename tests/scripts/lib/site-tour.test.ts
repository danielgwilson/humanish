import { describe, expect, it } from "vitest";
import { buildTour, type TourInput } from "../../../scripts/lib/site-tour.js";

// A synthetic two-turn run on drawDB: the shape run.json, the Observer's companion analysis record
// and `humanish verify --json` give the tour builder.
const at = (second: number): string => new Date(Date.UTC(2026, 9, 3, 10, 0, second)).toISOString();

const input: TourInput = {
  bundle: {
    runId: "cua-2026-10-03T10-00-00-000Z-synthetic",
    createdAt: at(0),
    subject: { source: "clone", repo: "drawdb-io/drawdb", commit: "e4e696f2d2b1" },
    review: { participants: { total: 1, reachedGoal: 1 } },
    cost: {
      estimatedTotalUsd: 0.015,
      fullyEstimated: false,
      ratesAsOf: "2026-09-05",
      placeholder: false,
    },
    streams: [
      {
        actor: {
          lane: "computer-use",
          persona: { id: "synthetic-new-user" },
          provider: "codex-participant",
          status: "passed",
          completionReason: "goal_satisfied",
          reason: "REACHED THE GOAL.",
          durationMs: 20_000,
          counts: { turns: 2, actions: 3, screenshots: 2 },
          items: [
            {
              id: "screenshot-001",
              kind: "screenshot",
              title: "turn-00-start",
              at: at(5),
              screenshotRef: { path: "screenshots/turn-00-start.png" },
            },
            {
              id: "reasoning-002",
              kind: "reasoning",
              text: "The editor is one click away.",
              at: at(6),
            },
            {
              id: "ui_action-003",
              kind: "ui_action",
              title: "click (373, 570)",
              coord: { x: 373, y: 570 },
              at: at(7),
            },
            {
              id: "screenshot-004",
              kind: "screenshot",
              title: "turn-01",
              at: at(8),
              screenshotRef: { path: "screenshots/turn-01.png" },
            },
            { id: "reasoning-005", kind: "reasoning", text: "Both tables are named.", at: at(9) },
            { id: "ui_action-006", kind: "ui_action", title: "type [9 chars]", at: at(10) },
            { id: "message-007", kind: "message", text: "REACHED THE GOAL.", at: at(11) },
          ],
        },
      },
    ],
  },
  analysis: {
    analysis: {
      completedAt: at(0 + 265),
      result: {
        summary: "The participant finished the task.",
        findings: [
          {
            title: "Overlapping tables",
            summary: "The second table covered the first.",
            impact: "friction",
          },
        ],
      },
    },
    spend: { requests: 1, estimatedUsd: 0.326028, complete: true, providers: ["openai"] },
  },
  verify: {
    checks: [
      { name: "run.json exists", ok: true, message: "" },
      { name: "public-safety scan", ok: true, message: "" },
    ],
    shareSafety: {
      status: "local_only",
      reasons: [{ code: "RAW_SCREENSHOTS", message: "Raw screenshots." }],
    },
  },
  frameSize: { w: 1440, h: 950 },
};

describe("the site tour built from a run bundle", () => {
  const tour = buildTour(input);
  const lane = tour.lanes[0]!;

  it("makes one frame per capture, at its published JPEG path, with what came before it", () => {
    expect(tour.runId).toBe("cua-2026-10-03T10-00-00-000Z-synthetic");
    expect(lane.frames.map((frame) => frame.file)).toEqual([
      "screenshots/turn-00-start.jpg",
      "screenshots/turn-01.jpg",
    ]);
    expect(lane.frames[0]).toMatchObject({ actionsBefore: [], reasoningBefore: [] });
    expect(lane.frames[1]!.actionsBefore).toEqual([
      {
        id: "ui_action-003",
        title: "click (373, 570)",
        coord: { x: 373, y: 570 },
        at: at(7),
        text: null,
      },
    ]);
    expect(lane.frames[1]!.reasoningBefore.map((reasoning) => reasoning.id)).toEqual([
      "reasoning-002",
    ]);
  });

  it("keeps what came after the last capture, with the closing message marked", () => {
    expect(lane.trailingActions.map((action) => action.coord)).toEqual([null]);
    expect(lane.trailingReasoning).toEqual([
      { id: "reasoning-005", text: "Both tables are named.", at: at(9) },
      { id: "message-007", text: "REACHED THE GOAL.", at: at(11), message: true },
    ]);
    expect(lane).toMatchObject({
      lane: "computer-use",
      persona: "synthetic-new-user",
      status: "passed",
      completionReason: "goal_satisfied",
      counts: { screenshots: 2 },
    });
  });

  it("carries the facts the study band prints, with the analysis in the cost", () => {
    expect(tour.facts).toEqual({
      date: "2026-10-03",
      subject: "drawdb-io/drawdb · commit-pinned",
      participants: "1/1 reached the goal",
      verifyChecks: "2/2 checks",
      status: "local_only",
      wallClock: "4m 25s incl. analysis",
      cost: "~$0.34 est. plus unpriced usage, with analysis",
      frameSize: { w: 1440, h: 950 },
    });
    expect(tour.findings).toEqual([
      {
        title: "Overlapping tables",
        summary: "The second table covered the first.",
        impact: "friction",
        evidence: [],
      },
    ]);
    expect(tour.verify?.reasons).toEqual([
      { code: "RAW_SCREENSHOTS", message: "Raw screenshots." },
    ]);
  });
});
