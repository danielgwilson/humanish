// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LoadedStudyAnalysis } from "../../src/study-analysis";
import { NO_ANALYSIS, parseStudyAnalysis, projectStudyAnalysis, readInlineStudyAnalysis, STUDY_ANALYSIS_PLACEHOLDER } from "../lib/study-analysis";
import { formatHash, parseHash } from "../lib/route";
import { resolveReportMoment } from "../lib/study-report";

// Same synthetic input used by the built-artifact browser suite. No provider wire
// response is asserted here; this checks the independent renderer contract.
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
const data = fixtures.fixture();
const fixture = () => fixtures.analysisFixture(data);

describe("independent analysis admission and projection", () => {
  it("projects distinct denominators, quoted feedback and exact source references", () => {
    const loaded = parseStudyAnalysis(fixture(), data);
    expect(loaded.state).toBe("ready");
    const report = projectStudyAnalysis(loaded, data)!;
    expect(report.findings[0]?.scope).toBe("1 of 3 exposed participants affected");
    expect(report.findings[0]?.account).toBe("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE");
    expect(report.findings[0]?.moments[0]).toMatchObject({ streamId: "lane-1", eventId: "lane-1-action-2" });
    expect(report.outcomes[0]).toEqual({ streamId: "lane-1", label: "Blocked" });
  });
  it.each([
    (v: LoadedStudyAnalysis) => { v.analysis!.runId = "other-study"; },
    (v: LoadedStudyAnalysis) => { v.analysis!.result!.findings[0]!.affectedStreamIds.push("lane-1"); },
    (v: LoadedStudyAnalysis) => { v.analysis!.result!.findings[0]!.exposedStreamIds = []; },
    (v: LoadedStudyAnalysis) => { v.analysis!.result!.findings[0]!.observations[0]!.evidenceIds = ["missing"]; },
    (v: LoadedStudyAnalysis) => { v.analysis!.evidence[0]!.eventId = "missing"; },
    (v: LoadedStudyAnalysis) => { v.analysis!.result!.participants[0]!.feedback[0]!.text = "An invented quote"; },
    (v: LoadedStudyAnalysis) => { v.analysis!.result!.participants[0]!.feedback[0]!.evidenceId = v.analysis!.evidence[0]!.id; },
  ])("rejects inconsistent references/counts/quotes without mutating recorded evidence", (change) => {
    const before = JSON.stringify(data), loaded = fixture(); change(loaded);
    expect(parseStudyAnalysis(loaded, data)).toMatchObject({ state: "invalid", analysis: null });
    expect(JSON.stringify(data)).toBe(before);
  });
  it("distinguishes empty, failed and stale analysis from no analysis", () => {
    expect(projectStudyAnalysis(NO_ANALYSIS, data)).toBeUndefined();
    const empty = fixture(); empty.analysis!.result!.findings = [];
    expect(projectStudyAnalysis(parseStudyAnalysis(empty, data), data)).toMatchObject({ state: "complete", findings: [] });
    const malformed = fixture(); malformed.analysis!.result = null;
    expect(parseStudyAnalysis(malformed, data).state).toBe("invalid");
    const failed = fixture(); failed.analysis!.result = null; failed.analysis!.status = "failed";
    expect(projectStudyAnalysis(parseStudyAnalysis(failed, data), data)).toMatchObject({ state: "failed", findings: [] });
    const stale = fixture(); stale.state = "stale"; stale.analysis!.evidence[0]!.eventId = "removed";
    expect(parseStudyAnalysis(stale, data).state).toBe("stale");
  });
  it("keeps corrections separate from the original claim", () => {
    const loaded = fixture(); loaded.corrections.push({ schema: "humanish.study-analysis-correction.v1", id: "correction-1", analysisId: loaded.analysis!.id, analysisSha256: "a".repeat(64),
      findingId: "F1", findingSha256: "b".repeat(64), createdAt: "2026-01-01T00:02:00Z", status: "dismissed", reason: "A synthetic reviewer rejected the claim.", replacementClaim: null });
    const result = projectStudyAnalysis(parseStudyAnalysis(loaded, data), data)!;
    expect(result.findings[0]?.title).toBe("A recorded action needs investigation");
    expect(result.findings[0]?.corrections?.[0]?.status).toBe("dismissed");
  });
  it("fails closed on malformed slot text while keeping older slots optional", () => {
    expect(readInlineStudyAnalysis(document, data)).toEqual(NO_ANALYSIS);
    const slot = document.createElement("script"); slot.id = "study-analysis"; document.body.append(slot);
    try {
      slot.textContent = STUDY_ANALYSIS_PLACEHOLDER; expect(readInlineStudyAnalysis(document, data)).toEqual(NO_ANALYSIS);
      slot.textContent = "{bad"; expect(readInlineStudyAnalysis(document, data).state).toBe("invalid");
      slot.textContent = JSON.stringify(fixture()); expect(readInlineStudyAnalysis(document, data).state).toBe("ready");
    } finally { slot.remove(); }
  });
  it("does not attach a future screenshot to earlier or nonvisual evidence", () => {
    const changed = structuredClone(data), stream = changed.streams[0]!;
    stream.actor!.items.unshift({ id: "before", kind: "message", lifecycle: "completed", title: "Before captures", at: "2000-01-01T00:00:00Z" });
    const before = resolveReportMoment(changed, stream.id, "before")!;
    expect(before.frame).toBeNull(); expect(before.elapsedMs).toBeNull();
    const href = formatHash(stream.id, before.frameIndex, null, before.eventId);
    expect(href).toBe("#/lane/lane-1/e/before");
    expect(parseHash(href)).toEqual({ laneId: stream.id, frame: null, eventId: "before" });
    const terminal = fixtures.fixture({ frames: 0 });
    expect(resolveReportMoment(terminal, "lane-1", "lane-1-final")).toMatchObject({ frame: null, eventId: "lane-1-final", text: "FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE" });
  });
});
