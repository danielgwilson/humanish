import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { ACTOR_TRACE_SCHEMA, CODEX_APP_SERVER_CAPABILITIES, type ActorTrace } from "../src/actor-contract.js";
import { exportRun } from "../src/export.js";
import { resolveRunPath, runDryRun, verifyRun, type RunBundle } from "../src/run.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { appendStudyAnalysisCorrection, loadStudyAnalysis, writeStudyAnalysis, writeStudyAnalysisExecutionReceipt } from "../src/study-analysis-store.js";
import { hashStudyAnalysisValue } from "../src/study-analysis-validation.js";
import { syntheticArtifact } from "./study-analysis-fixtures.js";

it("redacts legacy analysis-directory evidence while omitting generated analysis records", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-export-"));
  const runId = "synthetic-legacy-analysis";
  try {
    await runDryRun({ cwd, dryRun: true, runId });
    const prepared = (await resolveRunPath(cwd, runId))!;
    const root = prepared.physicalRunRoot;
    const image = new PNG({ width: 640, height: 400 });
    image.data.fill(150);
    const png = PNG.sync.write(image);
    await mkdir(path.join(root, "analysis"));
    await writeFile(path.join(root, "analysis", "frame.png"), png);
    await writeFile(path.join(root, "analysis", "legacy-notes.txt"), "Synthetic retained evidence.");
    const actor: ActorTrace = {
      schema: ACTOR_TRACE_SCHEMA, provider: "synthetic-fixture", protocol: "cua-loop", lane: "computer-use",
      persona: { id: "synthetic-new-user", traitsApplied: [], promptDigest: "0123456789abcdef" },
      redaction: { status: "passed", screenshots: "raw", notes: "Synthetic fixture." },
      startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:01.000Z", durationMs: 1000,
      status: "passed", completionReason: "goal_satisfied", reason: "Synthetic fixture completed.", ids: {},
      modelSettings: { reasoningEffort: "low", maxOutputTokens: 4096 }, counts: { messages: 1, actions: 1 },
      items: [{ id: "frame", kind: "screenshot", lifecycle: "completed", title: "Observed frame",
        screenshotRef: { path: "analysis/frame.png", redaction: "none" } }],
      capabilities: { ...CODEX_APP_SERVER_CAPABILITIES, lanes: ["computer-use"], producesScreenshots: true }
    };
    const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
    bundle.streams[0]!.actor = actor;
    bundle.streams[0]!.artifacts.push({ kind: "screenshot", label: "frame (raw)", path: "analysis/frame.png" });
    bundle.streams[0]!.artifacts.push({ kind: "trace", label: "actor", path: "actor.json" });
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
    await writeFile(path.join(root, "actor.json"), JSON.stringify(actor));
    const input = await captureStudyEvidence(prepared, await readFile(path.join(root, "run.json")));
    const artifact = syntheticArtifact(input);
    await writeStudyAnalysisExecutionReceipt(prepared, artifact);
    await writeStudyAnalysis(prepared, artifact);
    const correction = {
      schema: "humanish.study-analysis-correction.v1" as const, id: "synthetic-correction", analysisId: artifact.id,
      analysisSha256: hashStudyAnalysisValue(artifact), findingId: "finding-1",
      findingSha256: hashStudyAnalysisValue(artifact.result!.findings[0]), createdAt: "2026-09-01T00:03:00Z",
      status: "confirmed" as const, reason: "Synthetic review annotation.", replacementClaim: null
    };
    await appendStudyAnalysisCorrection(prepared, correction);
    const generatedPaths = [
      `analysis/${artifact.id}/analysis.json`,
      `analysis/${artifact.id}/corrections/${correction.id}/correction.json`,
      `analysis-attempts/${artifact.id}/receipt.json`,
      `analysis/${artifact.id}/.humanish-write-synthetic.tmp`
    ];
    await writeFile(path.join(root, generatedPaths[3]!), "Synthetic unpublished analysis bytes.");
    const sourcePaths = ["run.json", "actor.json", "analysis/frame.png", "analysis/legacy-notes.txt", ...generatedPaths];
    const originals = await Promise.all(sourcePaths.map((relative) => readFile(path.join(root, relative))));
    expect(await verifyRun(cwd, runId)).toMatchObject({ ok: true, shareSafety: { status: "local_only" } });

    const result = await exportRun(cwd, runId, { format: "bundle", redactScreenshots: true, out: "shared" });
    if (!result.ok) throw new Error(result.error.message);
    expect(result).toMatchObject({ embeddedImages: 1, shareSafety: { status: "share_ready" } });
    const shared = path.join(cwd, "shared");
    const derivative = (await resolveRunPath(shared, runId))!;
    const copied = JSON.parse(await readFile(path.join(derivative.physicalRunRoot, "run.json"), "utf8")) as RunBundle;
    expect(copied.streams[0]!.actor!.items[0]!.screenshotRef).toMatchObject({ path: "analysis/frame.png", redaction: "blurred" });
    const transformed = PNG.sync.read(await readFile(path.join(derivative.physicalRunRoot, "analysis/frame.png")));
    expect([transformed.width, transformed.height]).toEqual([96, 60]);
    expect(await readFile(path.join(derivative.physicalRunRoot, "analysis/legacy-notes.txt"), "utf8")).toBe("Synthetic retained evidence.");
    for (const relative of generatedPaths) await expect(access(path.join(derivative.physicalRunRoot, relative))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadStudyAnalysis(derivative)).state).toBe("none");
    expect((await verifyRun(shared, runId)).shareSafety.status).toBe("share_ready");
    for (let index = 0; index < sourcePaths.length; index++) {
      expect(await readFile(path.join(root, sourcePaths[index]!))).toEqual(originals[index]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
