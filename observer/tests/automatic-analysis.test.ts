import { describe, expect, it } from "vitest";
import { AUTOMATIC_STUDY_ANALYSIS_STALE_MS } from "../../src/study-analysis-job";
import { AUTOMATIC_ANALYSIS_STALE_MS, automaticAnalysisNotice, parseAutomaticAnalysis, type AutomaticStudyAnalysisView } from "../lib/automatic-analysis";
import { parseStudyAnalysis, projectStudyAnalysis } from "../lib/study-analysis";
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";

const now = Date.parse("2026-09-15T01:00:00.000Z");
const data = fixtures.fixture();
const job = (state: AutomaticStudyAnalysisView["state"] = "running"): AutomaticStudyAnalysisView => ({ state, analysisId: null, reason: null, updatedAt: new Date(now).toISOString() });

describe("independent automatic analysis metadata", () => {
  it("keeps absent metadata optional and does not invent an analysis artifact for a job", () => {
    expect(parseAutomaticAnalysis(undefined)).toBeUndefined();
    const loaded = parseStudyAnalysis({ state: "none", analysis: null, corrections: [], warnings: [], automatic: job() }, data);
    expect(loaded.automatic?.state).toBe("running");
    expect(loaded.analysis).toBeNull();
    expect(projectStudyAnalysis(loaded, data)).toBeUndefined();
  });
  it.each([null, {}, { ...job(), state: "invented" }, { ...job(), reason: "Provider returned private text" }, { ...job(), updatedAt: "1" }, { ...job(), updatedAt: "2026-02-30T01:00:00.000Z" }, { ...job(), analysisId: "../outside" }])("contains malformed job metadata without losing a valid prior artifact", (automatic) => {
    const loaded = parseStudyAnalysis({ ...fixtures.analysisFixture(data), automatic }, data);
    expect(loaded.state).toBe("ready");
    expect(loaded.analysis?.result?.findings).toHaveLength(2);
    expect(loaded.automatic).toMatchObject({ state: "unknown", reason: "ANALYSIS_AUTOMATIC_INVALID" });
  });
  it("retains valid execution metadata when the selected artifact is malformed", () => {
    const loaded = parseStudyAnalysis({ state: "ready", analysis: {}, corrections: [], warnings: [], automatic: job("failed") }, data);
    expect(loaded).toMatchObject({ state: "invalid", analysis: null, automatic: { state: "failed" } });
  });
  it("pins the browser freshness threshold to the producer contract", () => {
    expect(AUTOMATIC_ANALYSIS_STALE_MS).toBe(AUTOMATIC_STUDY_ANALYSIS_STALE_MS);
  });
  it.each(["queued", "running"] as const)("never presents a stale/future %s heartbeat as live", (state) => {
    expect(automaticAnalysisNotice(job(state), false, now + 15_000)).toMatchObject({ state, pending: true });
    for (const clock of [now + 15_001, now - 1]) expect(automaticAnalysisNotice(job(state), false, clock)).toMatchObject({ state: "unknown", pending: false });
  });
  it.each(["queued", "running"] as const)("makes saved %s metadata historical, including an old snapshot", (state) => {
    for (const clock of [now, now + 86400_000]) {
      const notice = automaticAnalysisNotice(job(state), true, clock);
      expect(notice).toMatchObject({ state: "unknown", pending: false });
      expect(notice.message).toBe(`This snapshot was saved while analysis was ${state}.`);
    }
  });
  it.each(["complete", "partial", "failed", "cancelled", "skipped", "unknown"] as const)("keeps terminal %s metadata independent of elapsed time", (state) => {
    expect(automaticAnalysisNotice(job(state), false, now + 86400_000)).toMatchObject({ state, pending: false });
  });
});
