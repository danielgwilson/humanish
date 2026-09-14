import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../src/run-paths.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { appendStudyAnalysisCorrection, listStudyAnalyses, listStudyAnalysisExecutions, loadStudyAnalysis, writeStudyAnalysis, writeStudyAnalysisExecutionReceipt } from "../src/study-analysis-store.js";
import { digestStudyAnalysisInput, hashStudyAnalysisValue } from "../src/study-analysis-validation.js";
import type { StudyAnalysisArtifact, StudyAnalysisCorrection, StudyAnalysisInput } from "../src/study-analysis.js";
import { syntheticArtifact } from "./study-analysis-fixtures.js";

describe("immutable study analysis store", () => {
  let cwd: string;
  let prepared: PreparedRunArtifactPaths;
  let source: Buffer;
  let input: StudyAnalysisInput;
  let artifact: StudyAnalysisArtifact;
  let png: Buffer;
  const artifactPath = (id = "analysis-1") => path.join(prepared.physicalRunRoot, "analysis", id, "analysis.json");
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-study-store-"));
    prepared = await prepareRunArtifactPaths(cwd, "synthetic-study");
    png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    await mkdir(path.join(prepared.physicalRunRoot, "captures"));
    await writeFile(path.join(prepared.physicalRunRoot, "captures", "frame.png"), png);
    source = Buffer.from(JSON.stringify({ schema: "humanish.run-bundle.v1", runId: "synthetic-study",
      streams: [{ id: "participant-a", simId: "sim-a", label: "Participant A", status: "complete",
        assignment: { mission: "Create an item." }, actor: { reason: "Finished.", items: [
          { id: "capture-1", kind: "screenshot", title: "Capture", screenshotRef: { path: "captures/frame.png", redaction: "none" } },
          { id: "account-1", kind: "message", title: "Account", text: "I could not create the item." }
        ] } }], events: [] }));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    input = await captureStudyEvidence(prepared, source);
    artifact = syntheticArtifact(input);
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("publishes a durable version without changing the run or persisting inline images", async () => {
    expect(input.images).toHaveLength(1);
    expect(input.evidence[0]!.at).toBeNull();
    expect(input.evidence[0]!.elapsedMs).toBeNull();
    await writeStudyAnalysis(prepared, artifact);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
    const saved = await readFile(artifactPath(), "utf8");
    expect(saved).not.toContain("data:image");
    expect(saved).not.toContain('"images"');
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", analysis: artifact, corrections: [], warnings: [] });
    await expect(writeStudyAnalysis(prepared, artifact)).rejects.toThrow("ANALYSIS_ID_EXISTS");
    expect(await readFile(artifactPath(), "utf8")).toBe(saved);
  });

  it("allows one publisher when concurrent callers claim the same immutable ID", async () => {
    const results = await Promise.allSettled([writeStudyAnalysis(prepared, artifact), writeStudyAnalysis(prepared, artifact)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await loadStudyAnalysis(prepared)).state).toBe("ready");
  });

  it("ignores interrupted directories and preserves a prior report after a failed attempt", async () => {
    await writeStudyAnalysis(prepared, artifact);
    await mkdir(path.join(prepared.physicalRunRoot, "analysis", "interrupted"));
    const failed = { ...artifact, id: "analysis-2", completedAt: "2026-09-01T00:03:00Z",
      status: "failed" as const, result: null, error: "analysis_provider_failed" };
    await writeStudyAnalysis(prepared, failed);
    const latest = await loadStudyAnalysis(prepared);
    expect(latest).toMatchObject({ state: "ready", analysis: { id: "analysis-1" }, warnings: ["ANALYSIS_FAILED"] });
    expect(await loadStudyAnalysis(prepared, "analysis-2")).toMatchObject({ state: "invalid", analysis: { status: "failed" } });
    expect(await listStudyAnalyses(prepared)).toHaveLength(2);
  });

  it("returns no analysis for an ordinary retained run", async () => {
    expect(await loadStudyAnalysis(prepared)).toEqual({ state: "none", analysis: null, corrections: [], warnings: [] });
  });

  it("marks changed run bytes stale and refuses publication against the earlier digest", async () => {
    await writeStudyAnalysis(prepared, artifact);
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), Buffer.concat([source, Buffer.from("\n")]));
    expect((await loadStudyAnalysis(prepared)).state).toBe("stale");
    await expect(writeStudyAnalysis(prepared, { ...artifact, id: "analysis-2" })).rejects.toThrow("ANALYSIS_SOURCE_CHANGED");
  });

  it("marks changed decoded capture bytes stale without serving mismatched findings", async () => {
    await writeStudyAnalysis(prepared, artifact);
    const image = new PNG({ width: 4, height: 4 }); image.data.fill(255);
    await writeFile(path.join(prepared.physicalRunRoot, "captures", "frame.png"), PNG.sync.write(image));
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "stale", analysis: null, warnings: ["ANALYSIS_CAPTURE_CHANGED"] });
  });

  it("never gives a forged path authority even after its input digest is recomputed", async () => {
    await writeFile(path.join(cwd, "outside.png"), png);
    artifact.evidence[0]!.capture!.path = "outside.png";
    artifact.inputDigest = digestStudyAnalysisInput(artifact);
    await expect(writeStudyAnalysis(prepared, artifact)).rejects.toThrow("ANALYSIS_CAPTURE_REFERENCE_INVALID");
    expect(await readFile(path.join(cwd, "outside.png"))).toEqual(png);
  });

  it("rejects changed participant context and false coverage even with recomputed digests", async () => {
    artifact.participants[0]!.assignment = "A different task.";
    artifact.inputDigest = digestStudyAnalysisInput(artifact);
    await expect(writeStudyAnalysis(prepared, artifact)).rejects.toThrow("ANALYSIS_PARTICIPANT_INPUT_INVALID");
    artifact = syntheticArtifact(await captureStudyEvidence(prepared, source));
    artifact.evidence[1]!.text = "I could not";
    artifact.result!.participants[0]!.feedback = [];
    artifact.inputDigest = digestStudyAnalysisInput(artifact);
    await expect(writeStudyAnalysis(prepared, artifact)).rejects.toThrow("ANALYSIS_COVERAGE_INCOMPLETE");
  });

  it("keeps invalid newer JSON visible as a warning without hiding valid findings", async () => {
    await writeStudyAnalysis(prepared, artifact);
    await mkdir(path.join(prepared.physicalRunRoot, "analysis", "analysis-2"));
    await writeFile(artifactPath("analysis-2"), '{"schema":"unexpected"}');
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", analysis: { id: "analysis-1" }, warnings: ["ANALYSIS_ARTIFACT_INVALID"] });
  });

  it.each(["symlink", "hardlink"] as const)("does not load a %s analysis file", async (kind) => {
    const outside = path.join(cwd, "outside.json");
    await writeFile(outside, JSON.stringify(artifact));
    await mkdir(path.dirname(artifactPath()), { recursive: true });
    if (kind === "symlink") await symlink(outside, artifactPath());
    else await link(outside, artifactPath());
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "invalid", analysis: null, warnings: ["ANALYSIS_ARTIFACT_UNREADABLE"] });
  });

  it("refuses unsafe analysis directories and traversal IDs without changing the outside sentinel", async () => {
    const outside = path.join(cwd, "outside"); await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "unchanged");
    await symlink(outside, path.join(prepared.physicalRunRoot, "analysis"));
    await expect(writeStudyAnalysis(prepared, artifact)).rejects.toThrow();
    expect((await loadStudyAnalysis(prepared)).state).toBe("invalid");
    expect((await loadStudyAnalysis(prepared, "../outside")).state).toBe("invalid");
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged");
  });

  const correction = (): StudyAnalysisCorrection => ({ schema: "humanish.study-analysis-correction.v1",
    id: "correction-1", analysisId: artifact.id, analysisSha256: hashStudyAnalysisValue(artifact),
    findingId: "finding-1", findingSha256: hashStudyAnalysisValue(artifact.result!.findings[0]),
    createdAt: "2026-09-01T00:03:00Z", status: "confirmed", reason: "The retained capture supports the claim.", replacementClaim: null });

  it("appends corrections bound to the exact analysis and finding without editing either", async () => {
    await writeStudyAnalysis(prepared, artifact);
    const before = await readFile(artifactPath());
    const record = correction();
    await appendStudyAnalysisCorrection(prepared, record);
    expect((await loadStudyAnalysis(prepared)).corrections).toEqual([record]);
    expect(await readFile(artifactPath())).toEqual(before);
    await expect(appendStudyAnalysisCorrection(prepared, record)).rejects.toThrow("ANALYSIS_ID_EXISTS");
  });

  it("rejects a correction targeting different analysis or finding content", async () => {
    await writeStudyAnalysis(prepared, artifact);
    await expect(appendStudyAnalysisCorrection(prepared, { ...correction(), findingSha256: "c".repeat(64) })).rejects.toThrow("ANALYSIS_CORRECTION_BINDING_INVALID");
    await expect(appendStudyAnalysisCorrection(prepared, { ...correction(), analysisSha256: "c".repeat(64) })).rejects.toThrow("ANALYSIS_CORRECTION_BINDING_INVALID");
  });

  it("does not carry approval forward to a subsequent analysis version", async () => {
    await writeStudyAnalysis(prepared, artifact);
    await appendStudyAnalysisCorrection(prepared, correction());
    await writeStudyAnalysis(prepared, { ...artifact, id: "analysis-2", completedAt: "2026-09-01T00:04:00Z" });
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", analysis: { id: "analysis-2" }, corrections: [] });
    expect((await loadStudyAnalysis(prepared, "analysis-1")).corrections).toHaveLength(1);
  });

  it("retains omission counts and original frame ordinals when an image limit excludes a capture", async () => {
    const changed = JSON.parse(source.toString());
    changed.streams[0].actor.items.push({ id: "capture-2", kind: "screenshot", title: "Second capture",
      at: "2026-09-01T00:00:10Z", screenshotRef: { path: "captures/frame.png", redaction: "none" } });
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    const selected = await captureStudyEvidence(prepared, source, { captures: 1 });
    expect(selected.coverage).toMatchObject({ complete: false, captureCount: 1, evidenceCount: 3 });
    expect(selected.evidence[2]).toMatchObject({ frame: 1, capture: null, elapsedMs: null });
    await writeStudyAnalysis(prepared, syntheticArtifact(selected));
    expect((await loadStudyAnalysis(prepared)).analysis?.status).toBe("partial");
  });

  it("does not analyze live participants or follow nonlocal screenshot references", async () => {
    const changed = JSON.parse(source.toString());
    changed.streams[0].status = "running";
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    await expect(captureStudyEvidence(prepared, source)).rejects.toThrow("ANALYSIS_RUN_UNFINISHED");
    changed.streams[0].status = "complete";
    changed.streams[0].actor.items[0].screenshotRef.path = "https://example.test/frame.png";
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    expect(await captureStudyEvidence(prepared, source)).toMatchObject({ images: [], coverage: { complete: false } });
  });

  it("retains accounting after source changes without persisting report or participant text", async () => {
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), Buffer.concat([source, Buffer.from("\n")]));
    await writeStudyAnalysisExecutionReceipt(prepared, artifact);
    await expect(writeStudyAnalysis(prepared, artifact)).rejects.toThrow("ANALYSIS_SOURCE_CHANGED");
    const execution = await listStudyAnalysisExecutions(prepared);
    expect(execution.warnings).toEqual([]);
    expect(execution.receipts).toHaveLength(1);
    expect(execution.receipts[0]).toMatchObject({ id: artifact.id, sourceRunSha256: artifact.sourceRunSha256, usage: artifact.usage });
    const saved = await readFile(path.join(prepared.physicalRunRoot, "analysis-attempts", artifact.id, "receipt.json"), "utf8");
    for (const text of ["participant-a", "Create an item", "I could not", "data:image", '"result"', '"config"', '"participants"', '"evidence"']) {
      expect(saved).not.toContain(text);
    }
    await expect(writeStudyAnalysisExecutionReceipt(prepared, artifact)).rejects.toThrow("ANALYSIS_ID_EXISTS");
  });

  it("retains failed execution accounting and rejects malformed receipt text", async () => {
    const failed = { ...artifact, status: "failed" as const, result: null, error: "analysis_provider_failed" };
    await writeStudyAnalysisExecutionReceipt(prepared, failed);
    expect((await listStudyAnalysisExecutions(prepared)).receipts[0]?.status).toBe("failed");
    const target = path.join(prepared.physicalRunRoot, "analysis-attempts", artifact.id, "receipt.json");
    const receipt = JSON.parse(await readFile(target, "utf8"));
    await writeFile(target, JSON.stringify({ ...receipt, privateTranscript: "Synthetic disallowed extra field" }));
    expect(await listStudyAnalysisExecutions(prepared)).toEqual({ receipts: [], warnings: ["ANALYSIS_RECEIPT_INVALID"] });
  });

  it("rejects linked execution receipts and cross-run execution IDs", async () => {
    await expect(writeStudyAnalysisExecutionReceipt(prepared, { ...artifact, runId: "different-study",
      inputDigest: digestStudyAnalysisInput({ ...artifact, runId: "different-study" }) })).rejects.toThrow("ANALYSIS_ID_MISMATCH");
    await writeStudyAnalysisExecutionReceipt(prepared, artifact);
    const target = path.join(prepared.physicalRunRoot, "analysis-attempts", artifact.id, "receipt.json");
    const outside = path.join(cwd, "outside-receipt.json");
    await writeFile(outside, await readFile(target));
    await rm(target);
    await symlink(outside, target);
    expect(await listStudyAnalysisExecutions(prepared)).toEqual({ receipts: [], warnings: ["ANALYSIS_RECEIPT_UNREADABLE"] });
  });

});
