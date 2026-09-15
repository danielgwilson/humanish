import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../src/run-paths.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { listStudyAnalysisExecutions, loadStudyAnalysis, writeStudyAnalysis, writeStudyAnalysisExecutionReceipt } from "../src/study-analysis-store.js";
import { digestStudyAnalysisInput, validateStudyAnalysisArtifact, validateStudyAnalysisInputMetadata } from "../src/study-analysis-validation.js";
import type { StudyAnalysisInput } from "../src/study-analysis.js";
import { syntheticArtifact } from "./study-analysis-fixtures.js";

// Original synthetic actor-contract fixture. Scripted captures belong to action
// events; these assertions do not claim a provider evaluated the fictional app.
describe("versioned scripted capture evidence", () => {
  let cwd: string;
  let prepared: PreparedRunArtifactPaths;
  const fixture = () => ({ schema: "humanish.run-bundle.v1", runId: "scripted-fixture", streams: [{
    id: "scripted", simId: "sim", label: "Scripted participant", status: "complete",
    ui: { intent: "Add a fictional note and inspect the saved list." },
    artifacts: Array.from({ length: 4 }, (_, i) => ({ kind: "screenshot", path: `screenshots/action-${i}.png` })),
    actor: { lane: "scripted-browser", status: "passed", completionReason: "goal_satisfied", items: Array.from({ length: 4 }, (_, i) => ({
      id: `action-${i}`, kind: "ui_action", lifecycle: "completed", status: "passed", title: `Action ${i}`,
      text: `Synthetic step ${i} completed.`, screenshotRef: { path: `screenshots/action-${i}.png`, redaction: "none" }
    })) }
  }], events: [{ id: "session-finished", streamId: "scripted", type: "scripted.finished", message: "The scripted session ended." }] });
  const save = async (bundle = fixture()) => {
    const source = Buffer.from(JSON.stringify(bundle));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    return source;
  };
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-scripted-evidence-"));
    prepared = await prepareRunArtifactPaths(cwd, "scripted-fixture");
    await mkdir(path.join(prepared.physicalRunRoot, "screenshots"));
    for (let i = 0; i < 4; i++) {
      const png = new PNG({ width: 4, height: 4 }); png.data.fill(i * 50);
      await writeFile(path.join(prepared.physicalRunRoot, "screenshots", `action-${i}.png`), PNG.sync.write(png));
    }
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("retains every attached capture, declared task and original action without inventing timestamps or quotes", async () => {
    const source = await save(), input = await captureStudyEvidence(prepared, source);
    expect(input.captureVersion).toBe(2);
    expect(input.coverage).toMatchObject({ evidenceCount: 5, captureCount: 4, complete: true, omissions: [] });
    expect(input.participants[0]!.assignment).toBe(fixture().streams[0]!.ui.intent);
    expect(input.evidence.slice(0, 4).map((entry) => [entry.eventId, entry.kind, entry.frame, entry.capture?.eventId, entry.at, entry.elapsedMs, entry.quoteEligible]))
      .toEqual(Array.from({ length: 4 }, (_, i) => [`action-${i}`, "ui_action", i, `action-${i}`, null, null, false]));
    expect(new Set(input.evidence.flatMap((entry) => entry.capture ? [entry.capture.sha256] : [])).size).toBe(4);
    expect(input.images).toHaveLength(4);
    await writeStudyAnalysis(prepared, syntheticArtifact(input));
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", analysis: { captureVersion: 2 } });
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it("keeps explicit assignments authoritative and never promotes another lane's display intent", async () => {
    const bundle = fixture();
    Object.assign(bundle.streams[0]!, { assignment: { mission: "Use the explicit task." } });
    expect((await captureStudyEvidence(prepared, await save(bundle))).participants[0]!.assignment).toBe("Use the explicit task.");
    const other = fixture(); other.streams[0]!.actor.lane = "cua";
    const input = await captureStudyEvidence(prepared, await save(other));
    expect(input.participants[0]!.assignment).toBeNull();
    expect(input.coverage.complete).toBe(false);
    expect(input.coverage.omissions).toContain("Some participants have no recorded assignment.");
  });

  it("retains original frame addresses when capture admission omits image bytes", async () => {
    const source = await save(), input = await captureStudyEvidence(prepared, source, { captures: 2 });
    expect(input.coverage).toMatchObject({ captureCount: 2, complete: false });
    expect(input.evidence.slice(0, 4).map((entry) => entry.frame)).toEqual([0, 1, 2, 3]);
    expect(input.evidence[3]!.capture).toBeNull();
    expect(input.coverage.omissions).toContain("Some captures were omitted by the capture count limit.");
    await writeStudyAnalysis(prepared, syntheticArtifact(input));
    expect((await loadStudyAnalysis(prepared)).state).toBe("ready");
  });

  it.each(["missing", "unsafe", "unmapped"])("discloses %s captures and refuses a forged complete claim", async (mode) => {
    const bundle = fixture();
    if (mode === "missing") await rm(path.join(prepared.physicalRunRoot, "screenshots/action-1.png"));
    if (mode === "unsafe") bundle.streams[0]!.actor.items[1]!.screenshotRef.path = "../outside.png";
    if (mode === "unmapped") bundle.streams[0]!.actor.items = [];
    const input = await captureStudyEvidence(prepared, await save(bundle));
    expect(input.coverage.complete).toBe(false);
    expect(input.coverage.omissions.length).toBeGreaterThan(0);
    input.coverage.complete = true; input.coverage.omissions = []; input.inputDigest = digestStudyAnalysisInput(input);
    await expect(writeStudyAnalysis(prepared, syntheticArtifact(input))).rejects.toThrow("ANALYSIS_COVERAGE_INCOMPLETE");
  });
  it.each(["ui", "embed"])("does not claim full coverage when an extra %s capture has no trace event", async (kind) => {
    const bundle = fixture(), stream = bundle.streams[0]!;
    if (kind === "ui") Object.assign(stream.ui, { screenshotUrl: "../screenshots/extra.png" });
    else Object.assign(stream, { embed: { kind: "screenshot", url: "../screenshots/extra.png" } });
    const input = await captureStudyEvidence(prepared, await save(bundle));
    expect(input.coverage).toMatchObject({ captureCount: 4, complete: false });
    expect(input.coverage.omissions).toContain("Some declared captures have no normalized trace reference.");
    expect(input.evidence.some((entry) => entry.capture?.path === "screenshots/extra.png")).toBe(false);
  });

  it("validates legacy text-only artifacts and receipts under their original digest without making them v2", async () => {
    const source = await save(), current = await captureStudyEvidence(prepared, source);
    const { captureVersion: _version, ...old } = structuredClone(current);
    const legacy: StudyAnalysisInput = { ...old, images: [], participants: old.participants.map((p) => ({ ...p, assignment: null })),
      evidence: old.evidence.map((entry) => ({ ...entry, frame: null, capture: null })),
      coverage: { ...old.coverage, captureCount: 0 }, inputDigest: "" };
    legacy.inputDigest = digestStudyAnalysisInput(legacy);
    expect(legacy.inputDigest).not.toBe(current.inputDigest);
    const artifact = syntheticArtifact(legacy, "legacy-analysis");
    await writeStudyAnalysis(prepared, artifact);
    await writeStudyAnalysisExecutionReceipt(prepared, artifact);
    const artifactPath = path.join(prepared.physicalRunRoot, "analysis/legacy-analysis/analysis.json");
    const receiptPath = path.join(prepared.physicalRunRoot, "analysis-attempts/legacy-analysis/receipt.json");
    const before = await Promise.all([readFile(artifactPath), readFile(receiptPath)]);
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", analysis: artifact });
    expect((await listStudyAnalysisExecutions(prepared)).receipts[0]).toMatchObject({ inputDigest: legacy.inputDigest });
    expect(await Promise.all([readFile(artifactPath), readFile(receiptPath)])).toEqual(before);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
    const forged = { ...artifact, id: "forged-v2", captureVersion: 2 as const };
    forged.inputDigest = digestStudyAnalysisInput(forged);
    await expect(writeStudyAnalysis(prepared, forged)).rejects.toThrow("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  });

  it("binds supported capture versions to the digest and rejects future versions", async () => {
    const input = await captureStudyEvidence(prepared, await save());
    const artifact = syntheticArtifact(input);
    const { captureVersion: _version, ...without } = artifact;
    expect(() => validateStudyAnalysisArtifact(without)).toThrow("ANALYSIS_DIGEST_INVALID");
    expect(() => validateStudyAnalysisArtifact({ ...artifact, captureVersion: 3 })).toThrow("ANALYSIS_ARTIFACT_SCHEMA_INVALID");
    expect(() => validateStudyAnalysisInputMetadata({ ...input, captureVersion: 3 } as unknown as StudyAnalysisInput)).toThrow("ANALYSIS_INPUT_INVALID");
  });
  it("does not turn a CUA backstop's contextual screenshot reference into another capture", async () => {
    const bundle = fixture(), stream = bundle.streams[0]!;
    stream.actor.lane = "computer-use";
    Object.assign(stream, { assignment: { mission: "Inspect the fictional interface." } });
    stream.actor.items.forEach((item) => { item.kind = "screenshot"; });
    stream.actor.items.push({ ...stream.actor.items[3]!, id: "backstop", kind: "notice", title: "computer-use backstop gave up", text: "No visible progress." });
    const input = await captureStudyEvidence(prepared, await save(bundle));
    expect(input.coverage).toMatchObject({ evidenceCount: 6, captureCount: 4, complete: true });
    expect(input.evidence[4]).toMatchObject({ eventId: "backstop", kind: "notice", frame: 3, capture: null, quoteEligible: false });
    await writeStudyAnalysis(prepared, syntheticArtifact(input));
    expect((await loadStudyAnalysis(prepared)).state).toBe("ready");
  });
});
