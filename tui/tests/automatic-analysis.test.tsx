import React from "react";
import { describe, expect, it } from "vitest";
import { RunScreen, runActions } from "../src/screens/run-screen.js";
import type { RunDetail } from "../../src/run-detail.js";
import type { AutomaticStudyAnalysisView } from "../../src/study-analysis-job.js";
import { normalizeFrame, renderToText } from "../src/testing/render-to-text.js";
import { NOW, RUNS } from "./fixtures.js";

const run = RUNS.find(value => value.liveness === "finished")!;
function detail(state: AutomaticStudyAnalysisView["state"]): RunDetail {
  return { schema: "humanish.run-detail.v1", runId: run.runId, participants: [], observerPath: ".humanish/runs/example/observer/index.html",
    automaticAnalysis: { state, analysisId: null, reason: null, updatedAt: new Date(NOW).toISOString() } };
}

describe("the separate analysis phase", () => {
  it.each([45, 80])("keeps participant outcome and analysis progress visible at %i columns", async columns => {
    const rendered = await renderToText(<RunScreen run={run} detail={detail("running")} columns={columns} viewport={20} selected={0} tick={0} now={NOW} actionNote={undefined} />,
      { columns, until: frame => frame.includes("Cancel analysis") });
    const frame = normalizeFrame(rendered.last); rendered.unmount();
    expect(frame).toContain("2/2 reached the goal"); expect(frame).toContain("Analysis: running");
    expect(frame).toContain("Open in Observer"); expect(frame).not.toContain("Run again");
    expect(frame.split("\n").every(line => [...line].length <= columns)).toBe(true);
  });
  it.each(["queued", "running"] as const)("only offers marker cancellation while analysis is %s", state => {
    expect(runActions(run, detail(state))).toEqual(["observer", "cancel-analysis"]);
  });
  it.each(["complete", "partial", "failed", "cancelled", "skipped", "unknown"] as const)("shows terminal state %s without changing participant outcome", async state => {
    const rendered = await renderToText(<RunScreen run={run} detail={detail(state)} columns={45} viewport={20} selected={0} tick={0} now={NOW} actionNote={undefined} />,
      { columns: 45, until: frame => frame.includes(`Analysis: ${state}`) });
    const frame = normalizeFrame(rendered.last); rendered.unmount();
    expect(frame).toContain("2/2 reached the goal"); expect(frame).not.toContain("Cancel analysis");
    expect(runActions(run, detail(state))).toEqual(["observer", "again"]);
  });
});
