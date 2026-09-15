// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LoadedStudyAnalysis } from "../../src/study-analysis";
import { fetchStudyAnalysis, NO_ANALYSIS, parseStudyAnalysis, projectStudyAnalysis, readInlineStudyAnalysis, STUDY_ANALYSIS_PLACEHOLDER } from "../lib/study-analysis";
import { formatHash, parseHash } from "../lib/route";
import { reportProblem, resolveReportMoment } from "../lib/study-report";

// Same synthetic input used by the built-artifact browser suite. No provider wire
// response is asserted here; this checks the independent renderer contract.
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
const data = fixtures.fixture();
const fixture = () => fixtures.analysisFixture(data);

describe("independent analysis admission and projection", () => {
  it("projects evidence-linked exclusions and preserves absence in older reports", () => {
    expect(projectStudyAnalysis(parseStudyAnalysis(fixture(), data), data)?.concernReviews).toBeUndefined();
    const saved = fixture(), f = saved.analysis!.result!.findings[0]!;
    saved.analysis!.result!.concernReviews = [{ ...f.observations[0]!, disposition: "context", findingId: null,
      reason: "The recorded exploration was not a separate task obstacle." }];
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(projected.concernReviews?.[0]).toMatchObject({ disposition: "context", findingId: null,
      moments: [{ streamId: "lane-1", eventId: "lane-1-action-2" }] });
    expect(projected.findings).toHaveLength(2);
    saved.analysis!.result!.concernReviews[0]!.findingId = "F1";
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
    saved.analysis!.result!.concernReviews[0]!.disposition = "finding";
    expect(parseStudyAnalysis(saved, data).state).toBe("ready");
    saved.analysis!.result!.concernReviews[0]!.evidenceIds = ["missing"];
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
  });
  it("rejects invalid visual and statement bases in an excluded concern", () => {
    const saved = fixture(), f = saved.analysis!.result!.findings[0]!;
    const entry = saved.analysis!.evidence.find(e => e.kind === "ui_action")!;
    entry.capture = null;
    saved.analysis!.result!.concernReviews = [{ ...f.observations[0]!, disposition: "unsupported", findingId: null,
      evidenceIds: [entry.id], reason: "No visual result was retained for this action.", basis: "visual" }];
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
    saved.analysis!.result!.concernReviews[0]!.basis = "participant_statement";
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
  });
  it("admits legacy and current capture versions while rejecting unknown future mappings", () => {
    const saved = fixture();
    expect(parseStudyAnalysis(saved, data).state).toBe("ready");
    saved.analysis!.captureVersion = 2;
    expect(parseStudyAnalysis(saved, data).state).toBe("ready");
    Object.assign(saved.analysis!, { captureVersion: 3 });
    expect(parseStudyAnalysis(saved, data)).toMatchObject({ state: "invalid", analysis: null });
  });
  it("projects distinct denominators, quoted feedback and exact source references", () => {
    const loaded = parseStudyAnalysis(fixture(), data);
    expect(loaded.state).toBe("ready");
    const report = projectStudyAnalysis(loaded, data)!;
    expect(report.findings[0]?.scope).toBe("1 of 3 exposed participants affected");
    expect(report.findings[0]?.accounts).toEqual([]);
    expect(report.findings[0]?.moments[0]).toMatchObject({ streamId: "lane-1", eventId: "lane-1-action-2" });
    expect(report.outcomes[0]).toEqual({ streamId: "lane-1", label: "Blocked" });
    expect(report.participants?.[0]).toMatchObject({ summary: "Recorded synthetic activity.", intent: "Inspect the fictional interface.", outcomeReason: "Synthetic interpretation kept separate from actor status.", stale: false });
    expect(report.participants?.[0]?.outcome).toBe("Blocked");
    expect(report.participants?.[0]?.moments[0]).toMatchObject({ eventId: "lane-1-frame-1", elapsedMs: 0, text: "Synthetic portrait capture 1" });
  });
  it("associates only cited quotes with their own speaker and preserves each observation basis", () => {
    const saved = fixture(), finding = saved.analysis!.result!.findings[0]!;
    finding.affectedStreamIds = ["lane-1", "lane-2"];
    const quote = saved.analysis!.result!.participants[0]!.feedback[0]!;
    const otherEvidence = saved.analysis!.evidence.find((e) => e.streamId === "lane-2" && e.kind === "screenshot")!;
    finding.observations.push({ claim: "A cited participant statement.", basis: "participant_statement", evidenceIds: [quote.evidenceId], limitation: "Statement only." },
      { claim: "A separate capture from the other affected participant.", basis: "visual", evidenceIds: [otherEvidence.id], limitation: "Does not cite that participant's feedback." });
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!.findings[0]!;
    expect(projected.accounts).toHaveLength(1);
    expect(projected.accounts?.[0]).toMatchObject({ streamId: "lane-1", eventId: "lane-1-final", text: quote.text });
    expect(projected.accounts?.[0]?.label).toBeTruthy();
    expect(projected.observations?.map((o) => o.basis)).toEqual(["action", "participant_statement", "visual"]);
    expect(projected.moments.find((m) => m.eventId === "lane-1-final")?.bases).toEqual(["participant_statement"]);
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
    const stale = fixture(); stale.state = "stale"; stale.analysis!.evidence[0]!.eventId = "removed";
    expect(parseStudyAnalysis(stale, data).state).toBe("stale");
  });
  it.each(["failed", "cancelled"] as const)("preserves the store's invalid selection with a valid %s artifact", (status) => {
    const saved = fixtures.analysisFixture(data, { status });
    expect(saved.state).toBe("invalid");
    const loaded = parseStudyAnalysis(saved, data);
    expect(loaded).toMatchObject({ state: "invalid", analysis: { status, result: null }, warnings: [`ANALYSIS_${status.toUpperCase()}`] });
    expect(projectStudyAnalysis(loaded, data)).toMatchObject({ state: status, findings: [], outcomes: [] });
    // A terminal record must never smuggle a successful interpretation through
    // the invalid selection, or erase the distinction between failure/cancel.
    saved.analysis!.result = fixture().analysis!.result;
    expect(parseStudyAnalysis(saved, data)).toMatchObject({ state: "invalid", analysis: null });
  });
  it("rejects a successful artifact under an invalid selection", () => {
    const saved = fixture(); saved.state = "invalid";
    expect(parseStudyAnalysis(saved, data)).toMatchObject({ state: "invalid", analysis: null });
  });
  it("keeps stale claims readable when a participant was removed, without current outcomes or fabricated evidence", () => {
    const saved = fixture(); saved.state = "stale";
    const current = structuredClone(data); current.streams = current.streams.slice(1);
    const loaded = parseStudyAnalysis(saved, current);
    const projected = projectStudyAnalysis(loaded, current)!;
    expect(loaded.state).toBe("stale"); expect(projected.findings).toHaveLength(2);
    expect(projected.outcomes).toEqual([]); expect(reportProblem(current, projected)).toBeNull();
    const moment = projected.findings[0]!.moments[0]!;
    expect(resolveReportMoment(current, moment.streamId, moment.eventId)).toBeNull();
    saved.state = "ready";
    expect(parseStudyAnalysis(saved, current)).toMatchObject({ state: "invalid", analysis: null });
  });
  it("retains the selected successful analysis when the store reports a later failed attempt", () => {
    const saved = fixture(); saved.warnings = ["ANALYSIS_FAILED"];
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(projected.state).toBe("complete"); expect(projected.findings).toHaveLength(2);
    expect(projected.messages).toContain("ANALYSIS_FAILED");
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

describe("bounded optional analysis fetch", () => {
  const signal = new AbortController().signal;
  const fetchResponse = (response: Response) => (async () => response) as typeof fetch;
  it("reads a valid streamed projection and treats missing companions as optional", async () => {
    expect(await fetchStudyAnalysis(fetchResponse(new Response(JSON.stringify(fixture()))), data, signal)).toMatchObject({ state: "ready" });
    expect(await fetchStudyAnalysis(fetchResponse(new Response(null, { status: 404 })), data, signal)).toEqual(NO_ANALYSIS);
  });
  it.each([true, false])("cancels over-limit data with declared length %s", async (declared) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1_000_001)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body, { headers: declared ? { "content-length": "8000001" } : {} });
    expect(await fetchStudyAnalysis(fetchResponse(response), data, signal)).toMatchObject({ state: "invalid", analysis: null });
    expect(cancelled).toBe(true);
  });
});
