import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../src/run-paths.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { appendStudyAnalysisCorrection, assertStudyAnalysisPublicationCapacity, beginStudyAnalysisExecution, listStudyAnalyses, listStudyAnalysisExecutions, loadStudyAnalysis, writeStudyAnalysis, writeStudyAnalysisExecutionReceipt } from "../src/study-analysis-store.js";
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

  it("checks publication capacity without creating either history directory", async () => {
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).resolves.toBeUndefined();
    for (const directory of ["analysis", "analysis-attempts"]) {
      await expect(access(path.join(prepared.physicalRunRoot, directory))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["analysis", "analysis-attempts"])("reserves one inventory slot in %s before dispatch", async (directory) => {
    const root = path.join(prepared.physicalRunRoot, directory);
    await mkdir(root);
    await Promise.all(Array.from({ length: 255 }, (_, index) => mkdir(path.join(root, `history-${index}`))));
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).resolves.toBeUndefined();
    await mkdir(path.join(root, "history-255"));
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).rejects.toThrow("ANALYSIS_HISTORY_UNAVAILABLE");
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it.each(["analysis", "analysis-attempts"])("refuses unsafe %s inventory before dispatch", async (directory) => {
    const root = path.join(prepared.physicalRunRoot, directory);
    await mkdir(root);
    const outside = path.join(cwd, "outside-history");
    await mkdir(outside);
    await symlink(outside, path.join(root, "unsafe-entry"));
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).rejects.toThrow("ANALYSIS_HISTORY_UNAVAILABLE");
    await rm(path.join(root, "unsafe-entry"));
    await writeFile(path.join(root, "analysis.json"), "{}");
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).rejects.toThrow("ANALYSIS_HISTORY_UNAVAILABLE");
  });

  it("counts safe legacy files against the same inventory capacity as listing", async () => {
    const root = path.join(prepared.physicalRunRoot, "analysis");
    await mkdir(root);
    await Promise.all(Array.from({ length: 255 }, (_, index) => writeFile(path.join(root, `legacy-${index}.txt`), "Synthetic evidence.")));
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).resolves.toBeUndefined();
    await writeFile(path.join(root, "legacy-255.txt"), "Synthetic evidence.");
    await expect(assertStudyAnalysisPublicationCapacity(prepared)).rejects.toThrow("ANALYSIS_HISTORY_UNAVAILABLE");
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

  it("refuses the 257th correction before claiming it and preserves all prior review decisions", async () => {
    await writeStudyAnalysis(prepared, artifact);
    const before = await readFile(artifactPath());
    const parent = path.join(prepared.physicalRunRoot, "analysis", artifact.id, "corrections");
    await mkdir(parent);
    const records = Array.from({ length: 255 }, (_, index) => ({ ...correction(),
      id: `correction-${String(index).padStart(3, "0")}` }));
    await Promise.all(records.map(async (record) => {
      const directory = path.join(parent, record.id);
      await mkdir(directory);
      await writeFile(path.join(directory, "correction.json"), JSON.stringify(record));
    }));
    const last = { ...correction(), id: "correction-255", status: "dismissed" as const };
    await appendStudyAnalysisCorrection(prepared, last);
    records.push(last);
    await expect(appendStudyAnalysisCorrection(prepared, { ...correction(), id: "correction-256" }))
      .rejects.toThrow("ANALYSIS_CORRECTION_HISTORY_UNAVAILABLE");
    await expect(access(path.join(parent, "correction-256"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", corrections: records, warnings: [] });
    expect(await readFile(artifactPath())).toEqual(before);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it.each(["oversized", "malformed", "empty", "symlink", "hardlink"] as const)(
    "warns when a present %s correction cannot preserve the recorded dismissal", async (kind) => {
      await writeStudyAnalysis(prepared, artifact);
      const record = { ...correction(), status: "dismissed" as const };
      await appendStudyAnalysisCorrection(prepared, record);
      expect((await loadStudyAnalysis(prepared)).corrections).toEqual([record]);
      const target = path.join(prepared.physicalRunRoot, "analysis", artifact.id, "corrections", record.id, "correction.json");
      if (kind === "oversized") await writeFile(target, JSON.stringify(record) + " ".repeat(33 * 1024));
      else if (kind === "malformed") await writeFile(target, '{"status":"dismissed"');
      else if (kind === "empty") await writeFile(target, "");
      else {
        const outside = path.join(cwd, "outside-correction.json");
        await writeFile(outside, JSON.stringify(record));
        await rm(target);
        if (kind === "symlink") await symlink(outside, target);
        else await link(outside, target);
      }
      const expected = ["malformed", "empty"].includes(kind) ? "ANALYSIS_CORRECTION_INVALID" : "ANALYSIS_CORRECTION_UNREADABLE";
      for (const id of [undefined, artifact.id]) {
        expect(await loadStudyAnalysis(prepared, id)).toMatchObject({
          state: "ready", analysis: { id: artifact.id }, corrections: [], warnings: [expected]
        });
      }
      expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
    }
  );

  it("ignores an unpublished correction directory while retaining an existing dismissal", async () => {
    await writeStudyAnalysis(prepared, artifact);
    const record = { ...correction(), status: "dismissed" as const };
    await appendStudyAnalysisCorrection(prepared, record);
    await mkdir(path.join(prepared.physicalRunRoot, "analysis", artifact.id, "corrections", "interrupted"));
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ corrections: [record], warnings: [] });
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
    expect(selected.evidence[0]).toMatchObject({ frame: 0, capture: null, elapsedMs: null });
    expect(selected.evidence[2]).toMatchObject({ frame: 1, capture: { eventId: "capture-2" }, elapsedMs: null });
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
    expect(execution.receipts[0]).toMatchObject({ id: artifact.id, sourceRunSha256: artifact.sourceRunSha256,
      model: artifact.config.model, maxCostUsd: artifact.config.maxCostUsd, usage: artifact.usage });
    const saved = await readFile(path.join(prepared.physicalRunRoot, "analysis-attempts", artifact.id, "receipt.json"), "utf8");
    for (const text of ["participant-a", "Create an item", "I could not", "data:image", '"result"', '"config"', '"participants"', '"evidence"']) {
      expect(saved).not.toContain(text);
    }
    await expect(writeStudyAnalysisExecutionReceipt(prepared, artifact)).rejects.toThrow("ANALYSIS_ID_EXISTS");
  });

  it("finalizes only the exact pre-dispatch directory it claimed", async () => {
    const { id, runId, sourceRunSha256, inputDigest, configDigest, promptVersion } = artifact;
    const context = { id, runId, sourceRunSha256, inputDigest, configDigest, promptVersion };
    const finalize = await beginStudyAnalysisExecution(prepared, context);
    await expect(beginStudyAnalysisExecution(prepared, context)).rejects.toThrow("ANALYSIS_ID_EXISTS");
    const target = path.join(prepared.physicalRunRoot, "analysis-attempts", id);
    const original = `${target}-original`;
    await rename(target, original);
    await mkdir(target);
    await expect(finalize(artifact)).rejects.toThrow();
    await expect(access(path.join(target, "receipt.json"))).rejects.toThrow();
    await expect(access(path.join(original, "start.json"))).resolves.toBeUndefined();
  });

  it("rejects a final receipt with a different dispatch context without replacing the start", async () => {
    const { id, runId, sourceRunSha256, inputDigest, configDigest, promptVersion } = artifact;
    const finalize = await beginStudyAnalysisExecution(prepared, { id, runId, sourceRunSha256, inputDigest, configDigest, promptVersion });
    await expect(finalize({ ...artifact, promptVersion: "different-prompt" })).rejects.toThrow("ANALYSIS_ID_MISMATCH");
    const target = path.join(prepared.physicalRunRoot, "analysis-attempts", id);
    await expect(access(path.join(target, "receipt.json"))).rejects.toThrow();
    await finalize(artifact);
    expect((await listStudyAnalysisExecutions(prepared)).receipts).toHaveLength(1);
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


  it("retains Observer frame ordinals when an inline legacy capture is intentionally omitted", async () => {
    const changed = JSON.parse(source.toString());
    changed.streams[0].actor.items.unshift({ id: "inline-legacy", kind: "screenshot", title: "Legacy inline capture",
      screenshotRef: { path: `data:image/png;base64,${png.toString("base64")}`, redaction: "none" } });
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    const captured = await captureStudyEvidence(prepared, source);
    expect(captured.coverage.complete).toBe(false);
    expect(captured.evidence[0]).toMatchObject({ frame: 0, capture: null });
    expect(captured.evidence[1]).toMatchObject({ frame: 1, capture: { eventId: "capture-1" } });
    expect(captured.images).toHaveLength(1);
  });


  it("retains completion provenance separately from participant declarations and task measurements", async () => {
    const changed = JSON.parse(source.toString());
    Object.assign(changed.streams[0].actor, {
      status: "passed", completionReason: "goal_satisfied", lane: "computer-use", protocol: "cua-loop",
      declaredOutcome: "blocked", taskFunnel: { tasks: [
        { id: "first-task", completed: true, observable: true, turn: 0 },
        { id: "unmeasured-task", completed: false, observable: true, inputsObserved: false },
        { id: "unobservable-task", completed: false, observable: false }
      ] }
    });
    for (const item of changed.streams[0].actor.items) item.lifecycle = "completed";
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    const captured = await captureStudyEvidence(prepared, source);
    expect(captured.participants[0]).toMatchObject({ recordedStatus: "complete", provenance: {
      actorStatus: "passed", completionReason: "goal_satisfied", stopCause: null,
      goalSource: "participant_report", declaredOutcome: "blocked", taskOutcomes: [
        { taskId: "first-task", completed: true, observable: true, inputsObserved: null, turn: 0 },
        { taskId: "unmeasured-task", completed: false, observable: true, inputsObserved: false, turn: null },
        { taskId: "unobservable-task", completed: false, observable: false, inputsObserved: null, turn: null }
      ]
    } });
    await writeStudyAnalysis(prepared, syntheticArtifact(captured));
    expect((await loadStudyAnalysis(prepared)).analysis?.participants).toEqual(captured.participants);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it("uses condition-matched provenance only for the recorded harness notice and preserves explicit interruption causes", async () => {
    const changed = JSON.parse(source.toString());
    Object.assign(changed.streams[0].actor, { status: "passed", completionReason: "goal_satisfied", lane: "computer-use", protocol: "cua-loop" });
    for (const item of changed.streams[0].actor.items) item.lifecycle = "completed";
    changed.streams[0].actor.items.push({ id: "matched-1", kind: "notice", lifecycle: "completed", status: "matched", title: "stopWhen matched: synthetic-check" });
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    expect((await captureStudyEvidence(prepared, source)).participants[0]!.provenance.goalSource).toBe("condition_matched");
    Object.assign(changed.streams[0].actor, { status: "incomplete", completionReason: "budget_reached", stopCause: "provider_output_limit" });
    changed.streams[0].status = "incomplete";
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    expect((await captureStudyEvidence(prepared, source)).participants[0]!.provenance).toMatchObject({
      actorStatus: "incomplete", completionReason: "budget_reached", stopCause: "provider_output_limit", goalSource: null
    });
  });

  it("keeps task goals paired with their IDs independently of measurement order", async () => {
    const changed = JSON.parse(source.toString());
    changed.streams[0].assignment.tasks = [
      { id: "opaque-b", goal: "Rename the item." }, { id: "opaque-a", goal: "Save the item." }
    ];
    changed.streams[0].actor.taskFunnel = { tasks: [
      { id: "opaque-a", completed: false, observable: true, inputsObserved: false },
      { id: "opaque-b", completed: true, observable: true, turn: 2 }
    ] };
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    const captured = await captureStudyEvidence(prepared, source);
    expect(captured.participants[0]!.assignment).toBe('Create an item.\nTask "opaque-b": Rename the item.\nTask "opaque-a": Save the item.');
    expect(captured.participants[0]!.provenance.taskOutcomes).toMatchObject([
      { taskId: "opaque-a", completed: false, inputsObserved: false },
      { taskId: "opaque-b", completed: true, inputsObserved: null }
    ]);
    expect(captured.coverage).toMatchObject({ complete: true, omissions: [] });
    await writeStudyAnalysis(prepared, syntheticArtifact(captured));
    expect((await loadStudyAnalysis(prepared)).analysis?.participants).toEqual(captured.participants);
    const forged = syntheticArtifact(captured, "analysis-forged");
    forged.participants[0]!.assignment = forged.participants[0]!.assignment!.replace('"opaque-b": Rename', '"opaque-a": Rename');
    forged.inputDigest = digestStudyAnalysisInput(forged);
    await expect(writeStudyAnalysis(prepared, forged)).rejects.toThrow("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  });

  it("declares truncation when task identifiers and goals exceed the assignment limit", async () => {
    const changed = JSON.parse(source.toString());
    changed.streams[0].assignment.tasks = [{ id: "opaque-a", goal: "Long task description. ".repeat(400) }];
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    const captured = await captureStudyEvidence(prepared, source);
    expect(Buffer.byteLength(captured.participants[0]!.assignment!)).toBeLessThanOrEqual(8000);
    expect(captured.coverage).toMatchObject({ complete: false, omissions: ["Participant context exceeded the text limit."] });
    await writeStudyAnalysis(prepared, syntheticArtifact(captured));
    expect((await loadStudyAnalysis(prepared)).state).toBe("ready");
  });

  it("preserves null versus an explicitly empty task measurement and rejects forged provenance", async () => {
    expect(input.participants[0]!.provenance).toEqual({ actorStatus: null, completionReason: null, stopCause: null,
      goalSource: null, declaredOutcome: null, taskOutcomes: null });
    const changed = JSON.parse(source.toString());
    changed.streams[0].actor.taskFunnel = { tasks: [] };
    source = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    const captured = await captureStudyEvidence(prepared, source);
    expect(captured.participants[0]!.provenance.taskOutcomes).toEqual([]);
    const forged = syntheticArtifact(captured);
    forged.participants[0]!.provenance.declaredOutcome = "reached";
    forged.inputDigest = digestStudyAnalysisInput(forged);
    await expect(writeStudyAnalysis(prepared, forged)).rejects.toThrow("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  });

  it("ignores unrelated legacy analysis files while retaining producer-record and link rejection", async () => {
    const directory = path.join(prepared.physicalRunRoot, "analysis");
    await mkdir(directory);
    await writeFile(path.join(directory, "frame.png"), png);
    await writeFile(path.join(directory, "observations.txt"), "Synthetic legacy observations.");
    expect(await loadStudyAnalysis(prepared)).toEqual({ state: "none", analysis: null, corrections: [], warnings: [] });
    await writeFile(path.join(directory, "analysis.json"), "{}");
    expect((await loadStudyAnalysis(prepared)).state).toBe("invalid");
    await rm(path.join(directory, "analysis.json"));
    const outside = path.join(cwd, "outside.txt");
    await writeFile(outside, "Synthetic unrelated file.");
    await link(outside, path.join(directory, "linked.txt"));
    expect((await loadStudyAnalysis(prepared)).state).toBe("invalid");
    await rm(path.join(directory, "linked.txt"));
    await symlink(outside, path.join(directory, ".humanish-write-synthetic.tmp"));
    expect((await loadStudyAnalysis(prepared)).state).toBe("invalid");
  });

});
