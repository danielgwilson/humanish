import { codexAnalysisIdentity } from "../../src/analysis/codex-config";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LoadedAnalysis } from "../../src/analysis/types";
import {
  fetchStudyAnalysis,
  NO_ANALYSIS,
  parseStudyAnalysis,
  projectStudyAnalysis,
  readInlineStudyAnalysis,
  STUDY_ANALYSIS_PLACEHOLDER,
} from "../lib/study-analysis";
import { formatHash, parseHash } from "../lib/route";
import {
  reportProblem,
  resolveReportMoment,
  representativeReportMoment,
} from "../lib/study-report";

// Same synthetic input used by the built-artifact browser suite. No provider wire
// response is asserted here; this checks the independent renderer contract.
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
const data = fixtures.fixture();
const fixture = () => fixtures.analysisFixture(data);

describe("independent analysis admission and projection", () => {
  it("retains the historical account profile independently of current launcher qualification", () => {
    const saved = fixture();
    saved.analysis!.provider = "codex";
    saved.analysis!.config = {
      provider: "codex",
      model: "gpt-6-astra",
      question: null,
      timeoutMs: 600000,
      maxCostUsd: null,
      maxOutputTokens: null,
      identity: {
        transport: "codex-app-server",
        authentication: "chatgpt-account",
        billing: "account-unknown",
        requestedModel: "gpt-6-astra",
        resolvedModel: "gpt-6-astra",
        reasoningEffort: "low",
        toolPolicy: "restricted-codex-v1",
        cliVersion: "0.154.0",
      },
    };
    saved.analysis!.usage.estimatedCostUsd = null;
    saved.analysis!.usage.estimatedAdmissionUsd = null;
    saved.analysis!.usage.ratesAsOf = null;
    expect(parseStudyAnalysis(saved, data).state).toBe("ready");
  });

  it("agrees with the current producer profile while preserving source links and unknown dollars", () => {
    const saved = fixture();
    saved.analysis!.provider = "codex";
    saved.analysis!.config = {
      provider: "codex",
      model: "gpt-6-astra",
      question: null,
      timeoutMs: 600000,
      maxCostUsd: null,
      maxOutputTokens: null,
      identity: codexAnalysisIdentity("gpt-6-astra"),
    };
    saved.analysis!.usage.estimatedCostUsd = null;
    saved.analysis!.usage.estimatedAdmissionUsd = null;
    saved.analysis!.usage.ratesAsOf = null;
    const selected = parseStudyAnalysis(saved, data);
    expect(selected.state).toBe("ready");
    const report = projectStudyAnalysis(selected, data)!;
    expect(report.findings[0]!.moments.length).toBeGreaterThan(0);
    expect(report.methodology.join(" ")).toContain("dollar cost and output-token ceiling unknown");
    expect(report.methodology.join(" ")).not.toContain("$null");
    const priced = structuredClone(saved);
    priced.analysis!.usage.estimatedCostUsd = 0;
    expect(parseStudyAnalysis(priced, data).state).toBe("invalid");
    const unqualified = structuredClone(saved);
    if (unqualified.analysis!.config.provider === "codex")
      unqualified.analysis!.config.identity.cliVersion = "unqualified";
    expect(parseStudyAnalysis(unqualified, data).state).toBe("invalid");
    const crossProvider = structuredClone(saved);
    crossProvider.analysis!.provider = "openai";
    expect(parseStudyAnalysis(crossProvider, data).state).toBe("invalid");
  });

  it("projects overview counts from structured coverage and judgments, not summary prose or actor success", () => {
    const saved = fixture();
    saved.analysis!.result!.summary =
      "All participants completed everything. This prose must not set the counts.";
    saved.analysis!.result!.participants[1]!.outcome = "interrupted";
    saved.analysis!.result!.participants[2]!.outcome = "unknown";
    const before = JSON.stringify(saved);
    const report = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(report.overview).toEqual({
      includedParticipants: 3,
      totalParticipants: 3,
      sampledCaptures: 12,
      totalCaptures: 12,
      outcomes: [
        { label: "Blocked", count: 1 },
        { label: "Interrupted", count: 1 },
        { label: "Unknown", count: 1 },
      ],
    });
    expect(JSON.stringify(saved)).toBe(before);
  });
  it("does not give stale analyses current denominators or current outcome counts", () => {
    const saved = fixture();
    saved.state = "stale";
    const changed = structuredClone(data);
    changed.streams.pop();
    const report = projectStudyAnalysis(parseStudyAnalysis(saved, changed), changed)!;
    expect(report.overview).toMatchObject({
      includedParticipants: 3,
      totalParticipants: null,
      sampledCaptures: 12,
      totalCaptures: null,
      outcomes: [],
    });
  });
  it("counts recorded scripted captures but not repeated contextual screenshot references", () => {
    const saved = fixture(),
      changed = structuredClone(data);
    const items = changed.streams[0]!.actor!.items!;
    items.push(
      {
        id: "scripted-capture",
        lifecycle: "completed",
        kind: "ui_action",
        title: "Captured action",
        screenshotRef: { path: "screenshots/scripted.png", redaction: "none" },
      },
      {
        id: "context-notice",
        lifecycle: "completed",
        kind: "reasoning",
        title: "Context",
        screenshotRef: { path: "screenshots/scripted.png", redaction: "none" },
      },
    );
    const report = projectStudyAnalysis(saved, changed)!;
    expect(report.overview).toMatchObject({ sampledCaptures: 12, totalCaptures: 13 });
  });
  it("keeps source interpretations intact while selecting a directly supported preview and separating caveats", () => {
    const saved = fixtures.reviewPolishFixture(data);
    const before = JSON.stringify(saved);
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    const finding = projected.findings[0]!;
    const moments = finding.moments.map((moment) => ({
      ...moment,
      resolved: resolveReportMoment(data, moment.streamId, moment.eventId),
    }));
    const lead = representativeReportMoment(moments)!;
    expect(lead.eventId).toBe("lane-1-frame-3");
    expect(lead.note).toBe("The third capture is the cited validation state.");
    expect(lead.bases).toEqual(["visual", "action"]);
    expect(
      finding.moments.find((moment) => moment.eventId === "lane-1-frame-1")?.observationCount,
    ).toBe(1);
    expect(finding.assessment).toMatchObject({ confidence: "medium", recovery: "Recovered" });
    expect(finding.assessment?.limitations).toHaveLength(3);
    expect(finding.observations).toHaveLength(8);
    expect(projected.messages).toHaveLength(1);
    expect(JSON.stringify(saved)).toBe(before);
    expect(formatHash(lead.streamId, lead.resolved!.frameIndex, null, lead.resolved!.eventId)).toBe(
      "#/lane/lane-1/f/3",
    );
  });
  it("projects evidence-linked exclusions and preserves absence in older reports", () => {
    expect(
      projectStudyAnalysis(parseStudyAnalysis(fixture(), data), data)?.concernReviews,
    ).toBeUndefined();
    const saved = fixture(),
      f = saved.analysis!.result!.findings[0]!;
    saved.analysis!.result!.concernReviews = [
      {
        ...f.observations[0]!,
        disposition: "context",
        findingId: null,
        reason: "The recorded exploration was not a separate task obstacle.",
      },
    ];
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(projected.concernReviews?.[0]).toMatchObject({
      disposition: "context",
      findingId: null,
      moments: [{ streamId: "lane-1", eventId: "lane-1-action-2" }],
    });
    expect(projected.findings).toHaveLength(2);
    saved.analysis!.result!.concernReviews[0]!.findingId = "F1";
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
    saved.analysis!.result!.concernReviews[0]!.disposition = "finding";
    expect(parseStudyAnalysis(saved, data).state).toBe("ready");
    saved.analysis!.result!.concernReviews[0]!.evidenceIds = ["missing"];
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
  });
  it("rejects invalid visual and statement bases in an excluded concern", () => {
    const saved = fixture(),
      f = saved.analysis!.result!.findings[0]!;
    const entry = saved.analysis!.evidence.find((e) => e.kind === "ui_action")!;
    entry.capture = null;
    saved.analysis!.result!.concernReviews = [
      {
        ...f.observations[0]!,
        disposition: "unsupported",
        findingId: null,
        evidenceIds: [entry.id],
        reason: "No visual result was retained for this action.",
        basis: "visual",
      },
    ];
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
    expect(report.findings[0]?.moments[0]).toMatchObject({
      streamId: "lane-1",
      eventId: "lane-1-action-2",
    });
    expect(report.outcomes[0]).toEqual({ streamId: "lane-1", label: "Blocked" });
    expect(report.participants?.[0]).toMatchObject({
      summary: "Recorded synthetic activity.",
      intent: "Inspect the fictional interface.",
      outcomeReason: "Synthetic interpretation kept separate from actor status.",
      stale: false,
    });
    expect(report.participants?.[0]?.outcome).toBe("Blocked");
    expect(report.participants?.[0]?.moments[0]).toMatchObject({
      eventId: "lane-1-frame-1",
      elapsedMs: 0,
      text: "Synthetic portrait capture 1",
    });
  });
  it("associates only cited quotes with their own speaker and preserves each observation basis", () => {
    const saved = fixture(),
      finding = saved.analysis!.result!.findings[0]!;
    finding.affectedStreamIds = ["lane-1", "lane-2"];
    const quote = saved.analysis!.result!.participants[0]!.feedback[0]!;
    const otherEvidence = saved.analysis!.evidence.find(
      (e) => e.streamId === "lane-2" && e.kind === "screenshot",
    )!;
    finding.observations.push(
      {
        claim: "A cited participant statement.",
        basis: "participant_statement",
        evidenceIds: [quote.evidenceId],
        limitation: "Statement only.",
      },
      {
        claim: "A separate capture from the other affected participant.",
        basis: "visual",
        evidenceIds: [otherEvidence.id],
        limitation: "Does not cite that participant's feedback.",
      },
    );
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!.findings[0]!;
    expect(projected.accounts).toHaveLength(1);
    expect(projected.accounts?.[0]).toMatchObject({
      streamId: "lane-1",
      eventId: "lane-1-final",
      text: quote.text,
    });
    expect(projected.accounts?.[0]?.label).toBeTruthy();
    expect(projected.observations?.map((o) => o.basis)).toEqual([
      "action",
      "participant_statement",
      "visual",
    ]);
    expect(projected.moments.find((m) => m.eventId === "lane-1-final")?.bases).toEqual([
      "participant_statement",
    ]);
  });
  it.each([
    (v: LoadedAnalysis) => {
      v.analysis!.runId = "other-study";
    },
    (v: LoadedAnalysis) => {
      v.analysis!.result!.findings[0]!.affectedStreamIds.push("lane-1");
    },
    (v: LoadedAnalysis) => {
      v.analysis!.result!.findings[0]!.exposedStreamIds = [];
    },
    (v: LoadedAnalysis) => {
      v.analysis!.result!.findings[0]!.observations[0]!.evidenceIds = ["missing"];
    },
    (v: LoadedAnalysis) => {
      v.analysis!.evidence[0]!.eventId = "missing";
    },
    (v: LoadedAnalysis) => {
      v.analysis!.result!.participants[0]!.feedback[0]!.text = "An invented quote";
    },
    (v: LoadedAnalysis) => {
      v.analysis!.result!.participants[0]!.feedback[0]!.evidenceId = v.analysis!.evidence[0]!.id;
    },
  ])(
    "rejects inconsistent references/counts/quotes without mutating recorded evidence",
    (change) => {
      const before = JSON.stringify(data),
        loaded = fixture();
      change(loaded);
      expect(parseStudyAnalysis(loaded, data)).toMatchObject({ state: "invalid", analysis: null });
      expect(JSON.stringify(data)).toBe(before);
    },
  );
  it("distinguishes empty, failed and stale analysis from no analysis", () => {
    expect(projectStudyAnalysis(NO_ANALYSIS, data)).toBeUndefined();
    const empty = fixture();
    empty.analysis!.result!.findings = [];
    expect(projectStudyAnalysis(parseStudyAnalysis(empty, data), data)).toMatchObject({
      state: "complete",
      findings: [],
    });
    const malformed = fixture();
    malformed.analysis!.result = null;
    expect(parseStudyAnalysis(malformed, data).state).toBe("invalid");
    const stale = fixture();
    stale.state = "stale";
    stale.analysis!.evidence[0]!.eventId = "removed";
    expect(parseStudyAnalysis(stale, data).state).toBe("stale");
  });
  it.each(["failed", "cancelled"] as const)(
    "preserves the store's invalid selection with a valid %s artifact",
    (status) => {
      const saved = fixtures.analysisFixture(data, { status });
      expect(saved.state).toBe("invalid");
      const loaded = parseStudyAnalysis(saved, data);
      expect(loaded).toMatchObject({
        state: "invalid",
        analysis: { status, result: null },
        warnings: [`ANALYSIS_${status.toUpperCase()}`],
      });
      expect(projectStudyAnalysis(loaded, data)).toMatchObject({
        state: status,
        findings: [],
        outcomes: [],
      });
      // A terminal record must never smuggle a successful interpretation through
      // the invalid selection, or erase the distinction between failure/cancel.
      saved.analysis!.result = fixture().analysis!.result;
      expect(parseStudyAnalysis(saved, data)).toMatchObject({ state: "invalid", analysis: null });
    },
  );
  it("rejects a successful artifact under an invalid selection", () => {
    const saved = fixture();
    saved.state = "invalid";
    expect(parseStudyAnalysis(saved, data)).toMatchObject({ state: "invalid", analysis: null });
  });
  it("keeps stale claims readable when a participant was removed, without current outcomes or fabricated evidence", () => {
    const saved = fixture();
    saved.state = "stale";
    const current = structuredClone(data);
    current.streams = current.streams.slice(1);
    const loaded = parseStudyAnalysis(saved, current);
    const projected = projectStudyAnalysis(loaded, current)!;
    expect(loaded.state).toBe("stale");
    expect(projected.findings).toHaveLength(2);
    expect(projected.outcomes).toEqual([]);
    expect(reportProblem(current, projected)).toBeNull();
    const moment = projected.findings[0]!.moments[0]!;
    expect(resolveReportMoment(current, moment.streamId, moment.eventId)).toBeNull();
    saved.state = "ready";
    expect(parseStudyAnalysis(saved, current)).toMatchObject({ state: "invalid", analysis: null });
  });
  it("retains the selected successful analysis when the store reports a later failed attempt", () => {
    const saved = fixture();
    saved.warnings = ["ANALYSIS_FAILED"];
    const projected = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(projected.state).toBe("complete");
    expect(projected.findings).toHaveLength(2);
    expect(projected.messages).toContain("ANALYSIS_FAILED");
  });
  it("keeps corrections separate from the original claim", () => {
    const loaded = fixture();
    loaded.corrections.push({
      schema: "humanish.study-analysis-correction.v1",
      id: "correction-1",
      analysisId: loaded.analysis!.id,
      analysisSha256: "a".repeat(64),
      findingId: "F1",
      findingSha256: "b".repeat(64),
      createdAt: "2026-01-01T00:02:00Z",
      status: "dismissed",
      reason: "A synthetic reviewer rejected the claim.",
      replacementClaim: null,
    });
    const result = projectStudyAnalysis(parseStudyAnalysis(loaded, data), data)!;
    expect(result.findings[0]?.title).toBe("A recorded action needs investigation");
    expect(result.findings[0]?.corrections?.[0]?.status).toBe("dismissed");
  });
  it("fails closed on malformed slot text while keeping older slots optional", () => {
    expect(readInlineStudyAnalysis(document, data)).toEqual(NO_ANALYSIS);
    const slot = document.createElement("script");
    slot.id = "study-analysis";
    // Matches observer/index.html; a classic script would execute the placeholder text.
    slot.type = "application/json";
    document.body.append(slot);
    try {
      slot.textContent = STUDY_ANALYSIS_PLACEHOLDER;
      expect(readInlineStudyAnalysis(document, data)).toEqual(NO_ANALYSIS);
      slot.textContent = "{bad";
      expect(readInlineStudyAnalysis(document, data).state).toBe("invalid");
      slot.textContent = JSON.stringify(fixture());
      expect(readInlineStudyAnalysis(document, data).state).toBe("ready");
    } finally {
      slot.remove();
    }
  });
  it("does not attach a future screenshot to earlier or nonvisual evidence", () => {
    const changed = structuredClone(data),
      stream = changed.streams[0]!;
    stream.actor!.items.unshift({
      id: "before",
      kind: "message",
      lifecycle: "completed",
      title: "Before captures",
      at: "2000-01-01T00:00:00Z",
    });
    const before = resolveReportMoment(changed, stream.id, "before")!;
    expect(before.frame).toBeNull();
    expect(before.elapsedMs).toBeNull();
    const href = formatHash(stream.id, before.frameIndex, null, before.eventId);
    expect(href).toBe("#/lane/lane-1/e/before");
    expect(parseHash(href)).toEqual({ laneId: stream.id, frame: null, eventId: "before" });
    const terminal = fixtures.fixture({ frames: 0 });
    expect(resolveReportMoment(terminal, "lane-1", "lane-1-final")).toMatchObject({
      frame: null,
      eventId: "lane-1-final",
      text: "FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE",
    });
  });
});

describe("bounded optional analysis fetch", () => {
  const signal = new AbortController().signal;
  const fetchResponse = (response: Response) => (async () => response) as typeof fetch;
  it("reads a valid streamed projection and treats missing companions as optional", async () => {
    expect(
      await fetchStudyAnalysis(
        fetchResponse(new Response(JSON.stringify(fixture()))),
        data,
        signal,
      ),
    ).toMatchObject({ state: "ready" });
    expect(
      await fetchStudyAnalysis(fetchResponse(new Response(null, { status: 404 })), data, signal),
    ).toEqual(NO_ANALYSIS);
  });
  it.each([true, false])("cancels over-limit data with declared length %s", async (declared) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: declared ? { "content-length": "8000001" } : {},
    });
    expect(await fetchStudyAnalysis(fetchResponse(response), data, signal)).toMatchObject({
      state: "invalid",
      analysis: null,
    });
    expect(cancelled).toBe(true);
  });
});

describe("plain headlines and design findings", () => {
  const amendment = (findingId: string) => ({
    schema: "humanish.study-analysis-correction.v1" as const,
    id: "correction-1",
    analysisId: "synthetic-analysis-1",
    analysisSha256: "c".repeat(64),
    findingId,
    findingSha256: "d".repeat(64),
    createdAt: "2026-10-07T00:00:00.000Z",
    status: "amended" as const,
    reason: "The capture shows the form was sent.",
    replacementClaim: "The form was sent, but its confirmation appeared late.",
  });

  it("projects each finding's headline and experience and orders design findings by severity", () => {
    const selected = parseStudyAnalysis(fixtures.plainFindingsFixture(data), data);
    expect(selected.state).toBe("ready");
    const report = projectStudyAnalysis(selected, data)!;
    expect(report.findings[0]).toMatchObject({
      title: "A recorded action needs investigation",
      headline: "One participant could not tell whether their form was sent.",
      experience: expect.stringMatching(/^They filled in the fictional form/),
    });
    expect(report.designFindings?.map((finding) => [finding.id, finding.severity])).toEqual([
      ["D2", "major"],
      ["D1", "minor"],
    ]);
    expect(report.designFindings![0]).toMatchObject({
      headline: "The Submit button is cut off at the bottom of the window.",
      screen: "Form page",
      seenByStreamIds: ["lane-1"],
      moments: [{ streamId: "lane-1", eventId: "lane-1-frame-3" }],
    });
    expect(reportProblem(data, report)).toBeNull();
  });

  it("shows the reviewer's claim in place of an amended finding's headline and experience", () => {
    const saved = fixtures.plainFindingsFixture(data);
    saved.corrections = [amendment("F1")];
    const report = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(report.findings[0]).toMatchObject({
      headline: "The form was sent, but its confirmation appeared late.",
      experience:
        "Corrected in human review. The reviewer's claim replaces the original headline and account.",
    });
    expect(report.findings[1]).toMatchObject({
      headline: "A participant said the second step's wording was unclear.",
    });
  });

  it("projects an analysis written before headlines and design findings as before", () => {
    const saved = fixture();
    saved.corrections = [amendment("F1")];
    const report = projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;
    expect(report.findings[0]!.title).toBe("A recorded action needs investigation");
    expect(report.findings[0]!.headline).toBeUndefined();
    expect(report.findings[0]!.experience).toBeUndefined();
    expect(report.designFindings).toBeUndefined();
  });

  it.each([
    "no capture",
    "unknown evidence",
    "a duplicate ID",
    "an uncited participant",
    "a participant cited only without a capture",
    "an unknown severity",
    "an empty headline",
    "an empty screen",
    "an empty notice",
    "an empty reason",
    "an empty suggestion",
    "a headline over 240 characters",
    "a notice over 1500 characters",
    "a control character in its notice",
  ])("refuses a design finding with %s", (kind) => {
    const saved = fixtures.plainFindingsFixture(data);
    const [minor, major] = saved.analysis!.result!.designFindings!;
    if (kind === "no capture")
      saved.analysis!.evidence.find((e) => e.id === minor!.evidenceIds[0])!.capture = null;
    if (kind === "unknown evidence") minor!.evidenceIds.push("missing");
    if (kind === "a duplicate ID") major!.id = minor!.id;
    if (kind === "an uncited participant") minor!.seenByStreamIds.push("lane-1");
    if (kind === "a participant cited only without a capture") {
      saved.analysis!.evidence.find((e) => e.id === "lane-1/lane-1-final")!.capture = null;
      minor!.evidenceIds.push("lane-1/lane-1-final");
      minor!.seenByStreamIds.push("lane-1");
    }
    if (kind === "an unknown severity") Object.assign(minor!, { severity: "critical" });
    if (kind === "an empty headline") minor!.headline = "";
    if (kind === "an empty screen") minor!.screen = "";
    if (kind === "an empty notice") minor!.notice = "";
    if (kind === "an empty reason") minor!.whyItMatters = "";
    if (kind === "an empty suggestion") minor!.suggestion = "";
    if (kind === "a headline over 240 characters") minor!.headline = "x".repeat(241);
    if (kind === "a notice over 1500 characters") minor!.notice = "x".repeat(1501);
    if (kind === "a control character in its notice") minor!.notice = "A bell \u0007 rang.";
    expect(parseStudyAnalysis(saved, data).state).toBe("invalid");
  });

  it("admits a design finding notice of 1500 characters with tabs and line breaks", () => {
    const saved = fixtures.plainFindingsFixture(data);
    saved.analysis!.result!.designFindings![0]!.notice = "Columns\tand\r\nrows ".padEnd(1500, "x");
    expect(parseStudyAnalysis(saved, data).state).toBe("ready");
  });

  it.each([
    ["empty", "", ""],
    ["over its limit", "x".repeat(241), "x".repeat(1201)],
  ])("refuses a finding whose headline or experience is %s", (_kind, headline, experience) => {
    const long = fixtures.plainFindingsFixture(data);
    long.analysis!.result!.findings[0]!.headline = headline;
    expect(parseStudyAnalysis(long, data).state).toBe("invalid");
    const account = fixtures.plainFindingsFixture(data);
    account.analysis!.result!.findings[0]!.experience = experience;
    expect(parseStudyAnalysis(account, data).state).toBe("invalid");
  });

  /** A current analysis as the producer writes it at `promptVersion`. */
  const atRevision = (promptVersion: string) => {
    const saved = fixtures.plainFindingsFixture(data);
    saved.analysis!.promptVersion = promptVersion;
    saved.analysis!.result!.concernReviews = [];
    return saved;
  };

  it("admits a study-evidence-7 analysis that carries every required field", () => {
    expect(parseStudyAnalysis(atRevision("study-evidence-7"), data).state).toBe("ready");
    expect(parseStudyAnalysis(atRevision("study-evidence-8"), data).state).toBe("ready");
  });

  it.each(["headline", "experience", "designFindings", "concernReviews"] as const)(
    "refuses a study-evidence-7 analysis without %s, and admits an older one",
    (field) => {
      const strip = (saved: LoadedAnalysis) => {
        const result = saved.analysis!.result!;
        if (field === "designFindings" || field === "concernReviews") delete result[field];
        else for (const finding of result.findings) delete finding[field];
        return saved;
      };
      expect(parseStudyAnalysis(strip(atRevision("study-evidence-7")), data).state).toBe("invalid");
      const older = strip(
        atRevision(field === "concernReviews" ? "study-evidence-4" : "study-evidence-6"),
      );
      expect(parseStudyAnalysis(older, data).state).toBe("ready");
    },
  );
});
