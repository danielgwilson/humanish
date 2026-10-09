import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorTraceItem } from "../../src/actors/contract.js";
import { estimateAnalysisCost } from "../../src/analysis/admission.js";
import {
  automaticAnalysisBudget,
  formatAutomaticAnalysisBudget,
  resolveAutomaticAnalysis,
} from "../../src/analysis/automatic-config.js";
import { captureEvidence, validateAnalysisEvidence } from "../../src/analysis/evidence.js";
import { estimateAnalysisAdmission, runAnalysis } from "../../src/analysis/execute.js";
import type { AnalysisFetch, AnalysisProvider } from "../../src/analysis/provider.js";
import type { AnalysisConfig, AnalysisInput, AnalysisResult } from "../../src/analysis/types.js";
import { digestAnalysisInput, validateAnalysisArtifact } from "../../src/analysis/validation.js";
import { MODEL_RATES } from "../../src/run/pricing.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { syntheticArtifact } from "./fixtures.js";

// Synthetic run bundles and provider answers only. The transport envelope and its usage come from
// a captured live response; provenance: fixtures/openai-closing-report/README.md.
const captured = JSON.parse(
  readFileSync(
    new URL("../fixtures/openai-closing-report/typed-closing-report.json", import.meta.url),
    "utf8",
  ),
);
const config: AnalysisConfig = {
  model: "gpt-6-astra",
  question: null,
  maxCostUsd: 100,
  timeoutMs: 1000,
  maxOutputTokens: 8192,
};

let cwd: string;
let prepared: PreparedRunArtifactPaths;
let png: Buffer;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-cohorts-"));
  prepared = await prepareRunArtifactPaths(cwd, "cohort-fixture");
  await fs.mkdir(path.join(prepared.physicalRunRoot, "screenshots"));
  const image = new PNG({ width: 4, height: 4 });
  image.data.fill(80);
  png = PNG.sync.write(image);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

const participantId = (index: number): string => `p${String(index).padStart(2, "0")}`;

/** A finished run of `participants` streams, each with `captures` screenshots and one message. */
async function saveRun(participants: number, captures: number): Promise<Buffer> {
  const streams = [];
  for (let index = 0; index < participants; index++) {
    const id = participantId(index);
    const items: ActorTraceItem[] = [];
    for (let frame = 0; frame < captures; frame++) {
      const capturePath = `screenshots/${id}-${frame}.png`;
      await fs.writeFile(path.join(prepared.physicalRunRoot, capturePath), png);
      items.push({
        id: `${id}-capture-${frame}`,
        kind: "screenshot",
        lifecycle: "completed",
        title: `Capture ${frame}`,
        screenshotRef: { path: capturePath, redaction: "none" },
      });
    }
    items.push({
      id: `${id}-account`,
      kind: "message",
      lifecycle: "completed",
      title: "Account",
      text: "I could not find the save button.",
    });
    streams.push({
      id,
      simId: id,
      label: `Participant ${index}`,
      status: "passed",
      assignment: { mission: "Change the reminder time and save it." },
      actor: { lane: "computer-use", status: "passed", completionReason: "turn_completed", items },
    });
  }
  const bytes = Buffer.from(
    JSON.stringify({
      schema: "humanish.run-bundle.v1",
      runId: "cohort-fixture",
      streams,
      events: [],
    }),
  );
  await fs.writeFile(path.join(prepared.physicalRunRoot, "run.json"), bytes);
  return bytes;
}

const capturesOf = (input: AnalysisInput, streamId: string): number =>
  input.evidence.filter((entry) => entry.streamId === streamId && entry.capture !== null).length;

describe("the evidence packet of a run with more than 16 participants", () => {
  it("includes all 17 participants, each with more captures than a 16-participant run gives", async () => {
    // Cohorts of 9 and 8, each with the 40-capture packet limit: 40 / 9 gives four or five
    // captures each, 40 / 8 gives five. Sixteen participants share one 40-capture packet.
    const source = await saveRun(17, 9);
    const input = await captureEvidence(prepared, source);
    expect(input.participants).toHaveLength(17);
    expect(input.coverage.omittedStreamIds).toEqual([]);
    expect(input.images).toHaveLength(80);
    for (let index = 0; index < 17; index++) {
      expect(capturesOf(input, participantId(index))).toBeGreaterThanOrEqual(4);
      expect(capturesOf(input, participantId(index))).toBeLessThanOrEqual(5);
    }
    expect(new Set(input.evidence.map((entry) => entry.id)).size).toBe(input.evidence.length);
    await expect(
      validateAnalysisEvidence(prepared, syntheticArtifact(input), source),
    ).resolves.toBeUndefined();
  });

  it("gives each of 40 participants at least the captures of a 16-participant run", async () => {
    // With three captures each, 16 participants in one packet keep two or three. Cohorts of 14, 13
    // and 13 keep 40, 39 and 39: two or three for the first cohort, all three for the others.
    const sixteen = await captureEvidence(prepared, await saveRun(16, 3));
    const fewest = Math.min(
      ...sixteen.participants.map((entry) => capturesOf(sixteen, entry.streamId)),
    );
    expect(fewest).toBe(2);
    const source = await saveRun(40, 3);
    const input = await captureEvidence(prepared, source);
    expect(input.participants).toHaveLength(40);
    expect(input.images).toHaveLength(118);
    for (const participant of input.participants)
      expect(capturesOf(input, participant.streamId)).toBeGreaterThanOrEqual(fewest);
    await expect(
      validateAnalysisEvidence(prepared, syntheticArtifact(input), source),
    ).resolves.toBeUndefined();
  });
});

describe("the stored analysis of a run with more than 16 participants", () => {
  it("admits and validates captures that total more than one packet's 20 MiB", async () => {
    const image = new PNG({ width: 640, height: 640 });
    let noise = 123456789;
    for (let index = 0; index < image.data.length; index++) {
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      image.data[index] = noise & 255;
    }
    png = PNG.sync.write(image);
    // Seventeen captures of about 1.6 MB are about 27 MB: 14 MB and 13 MB in the two cohorts.
    expect(17 * png.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(9 * png.length).toBeLessThan(20 * 1024 * 1024);
    const source = await saveRun(17, 1);
    const input = await captureEvidence(prepared, source);
    expect(input.images).toHaveLength(17);
    expect(estimateAnalysisAdmission(input, config)).toMatchObject({ allowed: true, error: null });
    await expect(
      validateAnalysisEvidence(prepared, syntheticArtifact(input), source),
    ).resolves.toBeUndefined();
  });
});

/** A packet like captureEvidence builds, without files: `entries` messages spread over participants. */
function packet(participants: number, entries: number, textBytes = 40): AnalysisInput {
  const ids = Array.from({ length: participants }, (_, index) => participantId(index));
  const input: AnalysisInput = {
    runId: "cohort-fixture",
    sourceRunSha256: "a".repeat(64),
    inputDigest: "",
    participants: ids.map((streamId) => ({
      streamId,
      label: streamId,
      assignment: "Change the reminder time and save it.",
      recordedStatus: "passed",
      recordedReason: null,
      provenance: {
        actorStatus: null,
        completionReason: null,
        stopCause: null,
        goalSource: null,
        declaredOutcome: null,
        taskOutcomes: null,
      },
    })),
    coverage: {
      includedStreamIds: ids,
      omittedStreamIds: [],
      evidenceCount: entries,
      captureCount: 0,
      complete: true,
      omissions: [],
    },
    evidence: Array.from({ length: entries }, (_, index) => ({
      id: `e${String(index + 1).padStart(6, "0")}`,
      streamId: ids[index % participants]!,
      eventId: `message-${index}`,
      kind: "message",
      text: "x".repeat(textBytes),
      quoteEligible: true,
      at: null,
      elapsedMs: null,
      frame: null,
      capture: null,
    })),
    images: [],
  };
  input.inputDigest = digestAnalysisInput(input);
  return input;
}

describe("admission for a run with more than 16 participants", () => {
  const rate = MODEL_RATES["gpt-6-astra"]!;

  it("prices each cohort request and a merge request that reads their whole output allowances", () => {
    // Input bills at gpt-6-astra's highest input rate, $12.50 per million (cache writes); output
    // at $50. Each cohort: 30,000 bytes are 10,000 tokens, plus 2,048 framing: 12,048 tokens. The
    // expected output is 12,000 plus 1,000 per participant. The merge request reads 1,000 tokens
    // of text, 2,048 framing and both reports at 32,768 tokens each: 68,584 tokens, and is
    // expected to write 12,000 plus 1,000 for each of the 17 participants.
    const size = { textBytes: 30_000, imageTokens: 0, outputAllowance: 32_768 };
    const estimate = estimateAnalysisCost(rate, {
      cohorts: [
        { ...size, participants: 9 },
        { ...size, participants: 8 },
      ],
      mergeTextBytes: 3_000,
    });
    expect(estimate).toMatchObject({
      inputTokens: 92_680,
      expectedOutputTokens: 70_000,
      // 1.2006 + 1.1506 + 2.3073
      expectedCostUsd: 4.6585,
      // 1.789 + 1.789 + 2.4957
      worstCaseCostUsd: 6.0737,
    });
    // 4.6585 plus 10% is 5.12435, rounded up to the micro-dollar.
    expect(estimate.admittedCostUsd).toBeGreaterThanOrEqual(5.12435);
    expect(estimate.admittedCostUsd).toBeLessThanOrEqual(5.124351);
  });

  it("counts the requests it prices: one up to 16 participants, then each cohort and the merge", () => {
    expect(estimateAnalysisAdmission(packet(16, 160), config).requests).toBe(1);
    expect(estimateAnalysisAdmission(packet(17, 170), config).requests).toBe(3);
    expect(estimateAnalysisAdmission(packet(40, 400), config).requests).toBe(4);
    expect(estimateAnalysisAdmission(packet(17, 17 * 89), config)).toMatchObject({
      error: "analysis_input_limit",
      requests: null,
    });
  });

  it("costs a 17-participant packet more than runs of its two cohorts' sizes", () => {
    // 88 entries for each participant: cohorts of 9 and 8 hold 792 and 704.
    const input = packet(17, 17 * 88);
    const whole = estimateAnalysisAdmission(input, config);
    const first = estimateAnalysisAdmission(packet(9, 9 * 88), config);
    const second = estimateAnalysisAdmission(packet(8, 8 * 88), config);
    expect(whole.allowed).toBe(true);
    expect(whole.estimatedCostUsd!).toBeGreaterThan(
      first.estimatedCostUsd! + second.estimatedCostUsd!,
    );
    expect(whole.worstCaseCostUsd!).toBeGreaterThan(
      first.worstCaseCostUsd! + second.worstCaseCostUsd!,
    );
    const refused = estimateAnalysisAdmission(input, {
      ...config,
      maxCostUsd: first.admittedCostUsd! + second.admittedCostUsd!,
    });
    expect(refused).toMatchObject({ allowed: false, error: "analysis_budget_exceeded" });
  });

  it("keeps the 800-entry limit for each cohort's request", () => {
    // Cohorts of 9 and 8 participants: 88 entries each are 792 and 704, 89 each are 801 and 712.
    expect(estimateAnalysisAdmission(packet(17, 17 * 88), config).allowed).toBe(true);
    expect(estimateAnalysisAdmission(packet(17, 17 * 89), config)).toMatchObject({
      allowed: false,
      error: "analysis_input_limit",
    });
  });

  it("names the cohorts in the plan's analysis line only past 16 participants", () => {
    const line = (participants: number) =>
      formatAutomaticAnalysisBudget(
        automaticAnalysisBudget(undefined, "computer-use", participants)!,
      );
    expect(line(16)).not.toMatch(/cohorts/);
    expect(line(24)).toMatch(
      /for 24 participants in 2 cohort requests of at most 16 participants and one merge request,/,
    );
  });

  it("gives study check a range for 40 participants that brackets their packets", () => {
    // An undeclared output limit is priced at the larger allowance a $1000 cap admits.
    const range = automaticAnalysisBudget(
      { maxCostUsd: 1000 },
      "computer-use",
      40,
    )?.expectedCostUsd;
    const roomy = { ...config, maxOutputTokens: 32_768 };
    const smallest = estimateAnalysisAdmission(packet(40, 40, 1), roomy).estimatedCostUsd!;
    // Cohorts of 14, 13 and 13 near the packet limits: 57 entries each make 798, 741 and 741
    // entries, and 190 bytes each about 152 KB of text per cohort.
    const largest = estimateAnalysisAdmission(packet(40, 40 * 57, 190), roomy).estimatedCostUsd!;
    expect(range!.low).toBeLessThanOrEqual(smallest);
    expect(range!.high).toBeGreaterThanOrEqual(largest);
  });
});

interface Packet {
  participants: Array<{ streamId: string }>;
  evidence: Array<{ id: string; streamId: string; hasCapture: boolean }>;
  cohorts?: Array<{ streamIds: string[]; report: AnalysisResult }>;
}

/** A cohort analyst's valid report: one finding and one design finding on its first participant. */
function cohortReport(packet: Packet): AnalysisResult {
  const ids = packet.participants.map((entry) => entry.streamId);
  const own = (streamId: string) => packet.evidence.filter((entry) => entry.streamId === streamId);
  const capture = own(ids[0]!).find((entry) => entry.hasCapture)!.id;
  return {
    summary: "Participants looked for a way to save the reminder time.",
    concernReviews: [],
    participants: ids.map((streamId) => ({
      streamId,
      summary: "Changed the reminder time and looked for a save control.",
      intent: "Save a new reminder time.",
      outcome: "unknown",
      outcomeReason: "No capture shows the saved time.",
      evidenceIds: own(streamId)
        .slice(0, 2)
        .map((entry) => entry.id),
      feedback: [],
      limitations: [],
    })),
    findings: [
      {
        id: "F1",
        title: "The save control was not found",
        headline: "A participant could not find how to save the reminder time.",
        experience: "They changed the time and then looked for a save button.",
        summary: "The capture shows no visible save control.",
        impact: "friction",
        affectedStreamIds: [ids[0]!],
        exposedStreamIds: ids,
        exposureReason: "Every participant in the cohort reached the reminder screen.",
        recovery: "unknown",
        confidence: "low",
        observations: [
          {
            claim: "The reminder screen shows no save control.",
            basis: "visual",
            evidenceIds: [capture],
            limitation: "One capture.",
          },
        ],
        nextStep: "Check whether the screen has a save control below the fold.",
        priorityReason: "It concerns the assigned task.",
      },
    ],
    designFindings: [
      {
        id: "D1",
        headline: "The reminder screen has no visible save button.",
        screen: "Reminder settings",
        notice: "No control on the screen saves the change.",
        whyItMatters: "A person cannot tell how to keep the new time.",
        suggestion: "Add a labelled save button under the time field.",
        severity: "moderate",
        confidence: "low",
        seenByStreamIds: [ids[0]!],
        evidenceIds: [capture],
      },
    ],
    limitations: ["Synthetic fixture."],
  };
}

/** The merge analyst's answer: each cohort's finding and design finding merged into one. */
function mergedReport(packet: Packet): Omit<AnalysisResult, "participants"> {
  const findings = packet.cohorts!.map((cohort) => cohort.report.findings[0]!);
  const designs = packet.cohorts!.map((cohort) => cohort.report.designFindings![0]!);
  return {
    summary: "In every cohort a participant could not find how to save the reminder time.",
    concernReviews: [],
    findings: [
      {
        ...findings[0]!,
        affectedStreamIds: findings.flatMap((finding) => finding.affectedStreamIds),
        exposedStreamIds: findings.flatMap((finding) => finding.exposedStreamIds),
        observations: findings.flatMap((finding) => finding.observations),
      },
    ],
    designFindings: [
      {
        ...designs[0]!,
        seenByStreamIds: designs.flatMap((design) => design.seenByStreamIds),
        evidenceIds: designs.flatMap((design) => design.evidenceIds),
      },
    ],
    limitations: ["Synthetic fixture."],
  };
}

interface SentRequest {
  packet: Packet;
  images: string[];
}

// `editWire` changes each answer's captured envelope, such as its reported usage.
function transport(
  answer: (packet: Packet) => unknown,
  editWire: (wire: typeof captured) => void = () => {},
) {
  const sent: SentRequest[] = [];
  const fetchFn = vi.fn<AnalysisFetch>(async (_url, init) => {
    const content = JSON.parse(init.body).input[0].content as Array<{
      type: string;
      text?: string;
    }>;
    const request = {
      packet: JSON.parse(content[0]!.text!) as Packet,
      images: content
        .filter((item) => item.type === "input_text" && item.text!.includes("captureEvidenceId"))
        .map((item) => JSON.parse(item.text!).captureEvidenceId as string),
    };
    sent.push(request);
    const output = answer(request.packet);
    if (output instanceof Response) return output;
    const wire = structuredClone(captured);
    wire.output[0].content[0].text = JSON.stringify(output);
    editWire(wire);
    return new Response(JSON.stringify(wire));
  });
  return { fetchFn, sent };
}

const answerEach = (packet: Packet): unknown =>
  packet.cohorts ? mergedReport(packet) : cohortReport(packet);

describe("one analysis of a run with more than 16 participants", () => {
  it("sends one request per cohort and one merge request, and keeps one report", async () => {
    const input = await captureEvidence(prepared, await saveRun(17, 3));
    const h = transport(answerEach);
    const artifact = await runAnalysis(input, config, {
      apiKey: "synthetic-key",
      fetch: h.fetchFn,
    });

    expect(h.sent).toHaveLength(3);
    const [first, second, merge] = h.sent as [SentRequest, SentRequest, SentRequest];
    const cohortIds = [first, second].map((request) =>
      request.packet.participants.map((entry) => entry.streamId),
    );
    expect(cohortIds.map((ids) => ids.length)).toEqual([9, 8]);
    expect(new Set(cohortIds.flat()).size).toBe(17);
    for (const [index, request] of [first, second].entries()) {
      const members = new Set(cohortIds[index]);
      const owner = new Map(input.evidence.map((entry) => [entry.id, entry.streamId]));
      expect(request.images.length).toBeGreaterThan(0);
      expect(request.images.every((id) => members.has(owner.get(id)!))).toBe(true);
    }
    // The merge request reads the cohort reports, not the evidence or the captures.
    expect(merge.images).toEqual([]);
    expect(merge.packet.evidence).toBeUndefined();
    expect(merge.packet.cohorts!.map((cohort) => cohort.streamIds)).toEqual(cohortIds);
    expect(merge.packet.cohorts!.map((cohort) => cohort.report)).toEqual(
      [first, second].map((request) => cohortReport(request.packet)),
    );

    expect(artifact).toMatchObject({ status: "complete", error: null });
    expect(artifact.result!.participants).toHaveLength(17);
    expect(artifact.result!.findings).toHaveLength(1);
    expect(artifact.result!.findings[0]!.affectedStreamIds).toEqual([
      cohortIds[0]![0],
      cohortIds[1]![0],
    ]);
    const evidence = new Set(artifact.evidence.map((entry) => entry.id));
    const cited = [
      ...artifact.result!.findings.flatMap((finding) =>
        finding.observations.flatMap((item) => item.evidenceIds),
      ),
      ...artifact.result!.designFindings!.flatMap((finding) => finding.evidenceIds),
      ...artifact.result!.participants.flatMap((review) => review.evidenceIds),
    ];
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((id) => evidence.has(id))).toBe(true);
    // The captured response used 13,543 input and 221 output tokens; three requests used three
    // times as many.
    expect(artifact.usage).toMatchObject({
      inputTokens: 40_629,
      outputTokens: 663,
      dispatched: true,
      usageComplete: true,
    });
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("fails the analysis without a merge request when one cohort's request fails", async () => {
    const input = await captureEvidence(prepared, await saveRun(40, 1));
    const failing = participantId(1);
    const h = transport((packet) =>
      packet.participants.some((entry) => entry.streamId === failing)
        ? new Response("", { status: 500 })
        : answerEach(packet),
    );
    const warnings: string[] = [];
    const artifact = await runAnalysis(input, config, {
      apiKey: "synthetic-key",
      fetch: h.fetchFn,
      warnings,
    });
    expect(h.sent).toHaveLength(3);
    expect(h.sent.some((request) => request.packet.cohorts)).toBe(false);
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_provider_http_error",
      usage: { inputTokens: 27_086, outputTokens: 442, dispatched: true, usageComplete: false },
    });
    expect(warnings).toHaveLength(1);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it.each([
    // The cohort report cites frame 1 only in the participant's review, and frame 2 nowhere.
    ["only in a participant review", 1],
    ["nowhere", 2],
  ])(
    "rejects a merged design finding on a capture the cohort reports cite %s",
    async (_where, frame) => {
      const input = await captureEvidence(prepared, await saveRun(17, 3));
      const capture = input.evidence.find(
        (entry) => entry.streamId === participantId(0) && entry.frame === frame,
      )!.id;
      const h = transport((packet) => {
        if (!packet.cohorts) return cohortReport(packet);
        const merged = mergedReport(packet);
        merged.designFindings![0]!.evidenceIds.push(capture);
        return merged;
      });
      const rejected: unknown[] = [];
      const artifact = await runAnalysis(input, config, {
        apiKey: "synthetic-key",
        fetch: h.fetchFn,
        onRejectedOutput: (output) => rejected.push(output),
      });
      expect(h.sent).toHaveLength(3);
      expect(artifact).toMatchObject({
        status: "failed",
        result: null,
        error: "analysis_validation_failed_merge_reference_invalid",
        usage: { inputTokens: 40_629, usageComplete: true },
      });
      expect(rejected).toHaveLength(1);
    },
  );
});

describe("the requests of an analysis in cohorts", () => {
  it("starts no queued cohort request after one fails", async () => {
    // 80 participants make five cohorts of 16; four start at once and the fifth waits.
    const input = await captureEvidence(prepared, await saveRun(80, 1));
    const h = transport((packet) =>
      packet.participants.some((entry) => entry.streamId === participantId(0))
        ? new Response("", { status: 500 })
        : answerEach(packet),
    );
    const artifact = await runAnalysis(
      input,
      { ...config, maxCostUsd: 1000 },
      {
        apiKey: "synthetic-key",
        fetch: h.fetchFn,
      },
    );
    expect(h.sent).toHaveLength(4);
    expect(artifact).toMatchObject({ status: "failed", error: "analysis_provider_http_error" });
  });

  it("fails the analysis with a warning when the merge request fails", async () => {
    const input = await captureEvidence(prepared, await saveRun(17, 1));
    const h = transport((packet) =>
      packet.cohorts ? new Response("", { status: 500 }) : answerEach(packet),
    );
    const warnings: string[] = [];
    const artifact = await runAnalysis(input, config, {
      apiKey: "synthetic-key",
      fetch: h.fetchFn,
      warnings,
    });
    expect(h.sent).toHaveLength(3);
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_provider_http_error",
      usage: { inputTokens: 27_086, usageComplete: false },
    });
    expect(warnings).toHaveLength(1);
  });

  it("sends no merge request after a cancellation during the cohort requests", async () => {
    const input = await captureEvidence(prepared, await saveRun(17, 1));
    const controller = new AbortController();
    const h = transport((packet) => {
      if (packet.participants.some((entry) => entry.streamId === participantId(1)))
        controller.abort();
      return answerEach(packet);
    });
    const artifact = await runAnalysis(input, config, {
      apiKey: "synthetic-key",
      fetch: h.fetchFn,
      signal: controller.signal,
    });
    expect(h.sent.some((request) => request.packet.cohorts)).toBe(false);
    expect(artifact).toMatchObject({
      status: "cancelled",
      error: "analysis_cancelled",
      result: null,
    });
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("marks a merged report partial when the summed bill passes the summed worst case", async () => {
    const input = await captureEvidence(prepared, await saveRun(17, 1));
    // Each request reports 600,000 input tokens: above the worst case of all three together.
    const h = transport(answerEach, (wire) => {
      wire.usage.input_tokens = 600_000;
      wire.usage.input_tokens_details.cache_write_tokens = 0;
    });
    const admission = estimateAnalysisAdmission(input, config);
    const artifact = await runAnalysis(input, config, {
      apiKey: "synthetic-key",
      fetch: h.fetchFn,
    });
    expect(artifact.usage.estimatedCostUsd).toBeGreaterThan(admission.worstCaseCostUsd!);
    expect(artifact).toMatchObject({
      status: "partial",
      error: "analysis_admission_estimate_exceeded",
      usage: { inputTokens: 1_800_000 },
    });
    expect(artifact.result!.participants).toHaveLength(17);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("sends Codex account requests one at a time", async () => {
    const input = await captureEvidence(prepared, await saveRun(17, 1));
    const selected = resolveAutomaticAnalysis({ provider: "codex", timeoutMs: 1000 });
    if (!selected.ok || selected.config?.provider !== "codex") throw new Error("not Codex");
    let inFlight = 0;
    let most = 0;
    const run = vi.fn<AnalysisProvider>(async (request) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return {
        status: "completed",
        output: answerEach(JSON.parse(request.evidence) as Packet),
        usage: { input: 100, output: 20 },
        usageComplete: true,
        dispatched: true,
        errorCode: null,
      };
    });
    const artifact = await runAnalysis(input, selected.config, { codexProvider: run });
    expect(run).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
    expect(artifact).toMatchObject({
      provider: "codex",
      status: "complete",
      usage: { inputTokens: 300, outputTokens: 60, estimatedCostUsd: null, usageComplete: true },
    });
  });
});
