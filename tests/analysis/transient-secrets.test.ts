import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import {
  registerTransientCommsSecrets,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { runAnalysis } from "../../src/analysis/execute.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import { writeAnalysis } from "../../src/analysis/store.js";
import type { AnalysisConfig, AnalysisInput, AnalysisResult } from "../../src/analysis/types.js";
import {
  digestAnalysisInput,
  validateAnalysisResult,
  validateAnalysisArtifact,
} from "../../src/analysis/validation.js";
import { syntheticPng1x1 } from "../image-fixtures.js";
import { syntheticResult } from "./fixtures.js";

// Transport shape and usage derive from the retained live response fixture; only its answer is synthetic.
const captured = JSON.parse(
  readFileSync(
    new URL("../fixtures/openai-closing-report/typed-closing-report.json", import.meta.url),
    "utf8",
  ),
);
const config: AnalysisConfig = {
  model: "gpt-5.6-sol",
  question: null,
  maxCostUsd: 5,
  timeoutMs: 1000,
  maxOutputTokens: 8192,
};
const OTP = "743921";
const LINK = `https://example.test/verify?code=${OTP}&proof=synthetic-value`;
function transport(answer: AnalysisResult, gate?: Promise<void>) {
  const wire = structuredClone(captured);
  wire.output[0].content[0].text = JSON.stringify(answer);
  return vi.fn<AnalysisFetch>(async () => {
    await gate;
    return new Response(JSON.stringify(wire));
  });
}
function addNarrativeCanaries(answer: AnalysisResult): AnalysisResult {
  const append = (value: string) => `${value} ${OTP} ${LINK}`;
  answer.summary = append(answer.summary);
  answer.limitations = [append("Review limitation.")];
  for (const participant of answer.participants) {
    participant.summary = append(participant.summary);
    participant.intent = append(participant.intent);
    participant.outcomeReason = append(participant.outcomeReason);
    participant.limitations = [append("Participant limitation.")];
  }
  for (const finding of answer.findings) {
    finding.title = append(finding.title);
    finding.summary = append(finding.summary);
    finding.exposureReason = append(finding.exposureReason);
    finding.nextStep = append(finding.nextStep);
    finding.priorityReason = append(finding.priorityReason);
    for (const observation of finding.observations) {
      observation.claim = append(observation.claim);
      observation.limitation = append(observation.limitation);
    }
  }
  answer.concernReviews = [
    {
      ...answer.findings[0]!.observations[0]!,
      disposition: "finding",
      findingId: answer.findings[0]!.id,
      reason: append("Retained concern."),
    },
  ];
  return answer;
}

/** The packet with one retained capture, so a design finding can cite it. */
function withCapture(input: AnalysisInput): AnalysisInput {
  const value = structuredClone(input);
  const bytes = syntheticPng1x1();
  const streamId = value.coverage.includedStreamIds[0]!;
  value.evidence.unshift({
    id: "capture-evidence",
    streamId,
    eventId: "screenshot-1",
    kind: "screenshot",
    text: "Captured account page.",
    quoteEligible: false,
    at: null,
    elapsedMs: 0,
    frame: 0,
    capture: {
      eventId: "screenshot-1",
      path: "screenshots/account.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "image/png",
    },
  });
  value.images = [
    {
      evidenceId: "capture-evidence",
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    },
  ];
  value.coverage.evidenceCount = value.evidence.length;
  value.coverage.captureCount = 1;
  value.inputDigest = digestAnalysisInput(value);
  return value;
}

describe("analysis scrubbing in the originating run scope", () => {
  let cwd: string;
  let prepared: PreparedRunArtifactPaths;
  let source: Buffer;
  let input: AnalysisInput;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-analysis-secrets-"));
    prepared = await prepareRunArtifactPaths(cwd, "synthetic-study");
    source = Buffer.from(
      JSON.stringify({
        schema: "humanish.run-bundle.v1",
        runId: "synthetic-study",
        publication: { restrictions: ["real-communications"] },
        streams: [
          {
            id: "participant-a",
            label: "Participant A",
            status: "complete",
            assignment: { mission: "Verify your account." },
            actor: {
              reason: "Finished.",
              items: [
                {
                  id: "account-1",
                  kind: "message",
                  title: "Participant account",
                  text: "I could not verify my account.",
                },
              ],
            },
          },
        ],
        events: [],
      }),
    );
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    input = await captureEvidence(prepared, source);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("scrubs echoed OTPs and links from all generated prose before validation and durable publication", async () => {
    const before = structuredClone(input);
    const answer = addNarrativeCanaries(syntheticResult(input));
    expect(validateAnalysisResult(input, answer)).toEqual(answer);
    const fetcher = transport(answer);
    const artifact = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([OTP, LINK]);
      return runAnalysis(input, config, { apiKey: "synthetic-key", fetch: fetcher });
    });
    expect(artifact).toMatchObject({
      status: "complete",
      error: null,
      usage: { dispatched: true, usageComplete: true },
    });
    const prose = JSON.stringify(artifact.result);
    expect(prose).not.toContain(OTP);
    expect(prose).not.toContain(LINK);
    expect(prose).not.toContain("https://example.test");
    expect(prose.match(/\[REDACTED_SECRET\]/g)).toHaveLength(32);
    expect(artifact.result?.participants[0]).toMatchObject({
      streamId: answer.participants[0]!.streamId,
      outcome: answer.participants[0]!.outcome,
      evidenceIds: answer.participants[0]!.evidenceIds,
      feedback: answer.participants[0]!.feedback,
    });
    expect(artifact.result?.findings[0]).toMatchObject({
      id: answer.findings[0]!.id,
      impact: answer.findings[0]!.impact,
      confidence: answer.findings[0]!.confidence,
      recovery: answer.findings[0]!.recovery,
      affectedStreamIds: answer.findings[0]!.affectedStreamIds,
      exposedStreamIds: answer.findings[0]!.exposedStreamIds,
    });
    expect(artifact.result?.findings[0]?.observations[0]).toMatchObject({
      basis: answer.findings[0]!.observations[0]!.basis,
      evidenceIds: answer.findings[0]!.observations[0]!.evidenceIds,
    });
    expect(artifact.result?.concernReviews?.[0]).toMatchObject({
      disposition: "finding",
      findingId: answer.findings[0]!.id,
    });
    expect(input).toEqual(before);
    expect(artifact.evidence).toEqual(before.evidence);
    expect(artifact.participants).toEqual(before.participants);
    expect(artifact.inputDigest).toBe(before.inputDigest);
    expect(artifact.sourceRunSha256).toBe(before.sourceRunSha256);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
    await writeAnalysis(prepared, artifact);
    const saved = await readFile(
      path.join(prepared.physicalRunRoot, "analysis", artifact.id, "analysis.json"),
      "utf8",
    );
    expect(saved).not.toContain(OTP);
    expect(saved).not.toContain(LINK);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
    expect(answer.summary).toContain(LINK);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("scrubs echoed OTPs and links from headlines, experiences and design findings", async () => {
    const packet = withCapture(input);
    const answer = syntheticResult(packet);
    const append = (value: string) => `${value} ${OTP} ${LINK}`;
    const finding = answer.findings[0]!;
    finding.headline = append(finding.headline!);
    finding.experience = append(finding.experience!);
    const design = answer.designFindings![0]!;
    for (const field of ["headline", "screen", "notice", "whyItMatters", "suggestion"] as const)
      design[field] = append(design[field]);
    expect(validateAnalysisResult(packet, answer)).toEqual(answer);
    const artifact = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([OTP, LINK]);
      return runAnalysis(packet, config, { apiKey: "synthetic-key", fetch: transport(answer) });
    });
    expect(artifact).toMatchObject({ status: "complete", error: null });
    const prose = JSON.stringify(artifact.result);
    expect(prose).not.toContain(OTP);
    expect(prose).not.toContain("https://example.test");
    expect(prose.match(/\[REDACTED_SECRET\]/g)).toHaveLength(14);
    expect(artifact.result?.findings[0]?.headline).toBe(
      "The participant could not create an item. [REDACTED_SECRET] [REDACTED_SECRET]",
    );
    expect(artifact.result?.designFindings).toMatchObject([
      {
        id: design.id,
        severity: design.severity,
        confidence: design.confidence,
        seenByStreamIds: design.seenByStreamIds,
        evidenceIds: design.evidenceIds,
        screen: "Item list [REDACTED_SECRET] [REDACTED_SECRET]",
      },
    ]);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("isolates secrets across overlapping provider requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const left = "run-left-canary";
    const right = "run-right-canary";
    const answer = syntheticResult(input);
    answer.summary = `${left} ${right}`;
    const requests = [transport(answer, gate), transport(answer, gate)];
    const results = [left, right].map((value, index) =>
      withTransientCommsSecrets(async () => {
        registerTransientCommsSecrets([value]);
        return runAnalysis(input, config, {
          apiKey: "synthetic-key",
          fetch: requests[index]!,
        });
      }),
    );
    // Both analyses prepare their packets before dispatch; under load that can outlast 1 s.
    await vi.waitFor(
      () => {
        for (const request of requests) expect(request).toHaveBeenCalledOnce();
      },
      { timeout: 15_000 },
    );
    release();
    const [a, b] = await Promise.all(results);
    expect(a!.result?.summary).toBe(`[REDACTED_SECRET] ${right}`);
    expect(b!.result?.summary).toBe(`${left} [REDACTED_SECRET]`);
  });

  it("fails safely if replacement expands an otherwise valid field beyond its limit", async () => {
    const answer = syntheticResult(input);
    answer.findings[0]!.title = OTP.repeat(39);
    expect(validateAnalysisResult(input, answer)).toEqual(answer);
    const artifact = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([OTP]);
      return runAnalysis(input, config, { apiKey: "synthetic-key", fetch: transport(answer) });
    });
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_validation_failed_schema_invalid",
      usage: { dispatched: true, usageComplete: true, outputTokens: 221 },
    });
    expect(JSON.stringify(artifact)).not.toContain(OTP);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("does not rewrite an exact source quote to make a scrubbed quotation pass validation", async () => {
    const raw = JSON.parse(source.toString("utf8"));
    raw.streams[0].actor.items[0].text = `I entered code ${OTP}.`;
    source = Buffer.from(JSON.stringify(raw));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    input = await captureEvidence(prepared, source);
    const answer = syntheticResult(input);
    expect(validateAnalysisResult(input, answer)).toEqual(answer);
    const before = structuredClone(input);
    const artifact = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([OTP]);
      return runAnalysis(input, config, { apiKey: "synthetic-key", fetch: transport(answer) });
    });
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_validation_failed_quote_invalid",
      usage: { dispatched: true, usageComplete: true },
    });
    expect(artifact.evidence).toEqual(before.evidence);
    expect(input).toEqual(before);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it("refuses a secret echoed as an otherwise valid generated finding ID", async () => {
    const secret = "synthetic-management-key-canary";
    const answer = syntheticResult(input);
    answer.findings[0]!.id = secret;
    expect(validateAnalysisResult(input, answer)).toEqual(answer);
    const artifact = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([secret]);
      return runAnalysis(input, config, { apiKey: "synthetic-key", fetch: transport(answer) });
    });
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_validation_failed_scrub_rejected",
      usage: { dispatched: true, usageComplete: true },
    });
    expect(JSON.stringify(artifact)).not.toContain(secret);
  });

  it("refuses a secret echoed as an otherwise valid design finding ID", async () => {
    const secret = "synthetic-management-key-canary";
    const packet = withCapture(input);
    const answer = syntheticResult(packet);
    answer.designFindings![0]!.id = secret;
    expect(validateAnalysisResult(packet, answer)).toEqual(answer);
    const artifact = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([secret]);
      return runAnalysis(packet, config, { apiKey: "synthetic-key", fetch: transport(answer) });
    });
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_validation_failed_scrub_rejected",
      usage: { dispatched: true, usageComplete: true },
    });
    expect(JSON.stringify(artifact)).not.toContain(secret);
  });
});
