import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  type ActorTrace,
} from "../../src/actors/contract.js";
import { exportRun } from "../../src/feedback/export.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { type RunBundle } from "../../src/run/bundle.js";
import { captureStudyEvidence } from "../../src/analysis/evidence.js";
import { appendStudyAnalysisCorrection, writeStudyAnalysis } from "../../src/analysis/store.js";
import { writeStudyAnalysisExecutionReceipt } from "../../src/analysis/store-executions.js";
import { loadStudyAnalysis } from "../../src/analysis/load.js";
import { hashAnalysisValue } from "../../src/analysis/validation.js";
import { syntheticArtifact } from "../analysis/fixtures.js";

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
    await mkdir(path.join(root, "screenshots"));
    await writeFile(path.join(root, "screenshots", "frame.png"), png);
    await writeFile(
      path.join(root, "analysis", "legacy-notes.txt"),
      "Synthetic retained evidence.",
    );
    const actor: ActorTrace = {
      schema: ACTOR_TRACE_SCHEMA,
      provider: "synthetic-fixture",
      protocol: "cua-loop",
      lane: "computer-use",
      persona: { id: "synthetic-new-user", traitsApplied: [], promptDigest: "0123456789abcdef" },
      redaction: { status: "passed", screenshots: "raw", notes: "Synthetic fixture." },
      startedAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:01.000Z",
      durationMs: 1000,
      status: "passed",
      completionReason: "goal_satisfied",
      reason: "Synthetic fixture completed.",
      ids: {},
      modelSettings: { reasoningEffort: "low", maxOutputTokens: 4096 },
      counts: { messages: 1, actions: 1 },
      items: [
        {
          id: "frame",
          kind: "screenshot",
          lifecycle: "completed",
          title: "Observed frame",
          screenshotRef: { path: "screenshots/frame.png", redaction: "none" },
        },
      ],
      capabilities: {
        ...CODEX_APP_SERVER_CAPABILITIES,
        lanes: ["computer-use"],
        producesScreenshots: true,
      },
    };
    const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
    bundle.streams[0]!.actor = actor;
    bundle.streams[0]!.artifacts.push({
      kind: "screenshot",
      label: "frame (raw)",
      path: "screenshots/frame.png",
    });
    bundle.streams[0]!.artifacts.push({ kind: "trace", label: "actor", path: "actor.json" });
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
    await writeFile(path.join(root, "actor.json"), JSON.stringify(actor));
    const input = await captureStudyEvidence(prepared, await readFile(path.join(root, "run.json")));
    const artifact = syntheticArtifact(input);
    await writeStudyAnalysisExecutionReceipt(prepared, artifact);
    await writeStudyAnalysis(prepared, artifact);
    const correction = {
      schema: "humanish.study-analysis-correction.v1" as const,
      id: "synthetic-correction",
      analysisId: artifact.id,
      analysisSha256: hashAnalysisValue(artifact),
      findingId: "finding-1",
      findingSha256: hashAnalysisValue(artifact.result!.findings[0]),
      createdAt: "2026-09-01T00:03:00Z",
      status: "confirmed" as const,
      reason: "Synthetic review annotation.",
      replacementClaim: null,
    };
    await appendStudyAnalysisCorrection(prepared, correction);
    const generatedPaths = [
      `analysis/${artifact.id}/analysis.json`,
      `analysis/${artifact.id}/corrections/${correction.id}/correction.json`,
      `analysis-attempts/${artifact.id}/receipt.json`,
      `analysis/${artifact.id}/.humanish-write-synthetic.tmp`,
    ];
    await writeFile(path.join(root, generatedPaths[3]!), "Synthetic unpublished analysis bytes.");
    const sourcePaths = [
      "run.json",
      "actor.json",
      "screenshots/frame.png",
      "analysis/legacy-notes.txt",
      ...generatedPaths,
    ];
    const originals = await Promise.all(
      sourcePaths.map((relative) => readFile(path.join(root, relative))),
    );
    expect(await verifyRun(cwd, runId)).toMatchObject({
      ok: true,
      shareSafety: { status: "local_only" },
    });

    const result = await exportRun(cwd, runId, {
      format: "bundle",
      redactScreenshots: true,
      out: "shared",
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result).toMatchObject({ embeddedImages: 1, shareSafety: { status: "share_ready" } });
    const shared = path.join(cwd, "shared");
    const derivative = (await resolveRunPath(shared, runId))!;
    const copied = JSON.parse(
      await readFile(path.join(derivative.physicalRunRoot, "run.json"), "utf8"),
    ) as RunBundle;
    expect(copied.streams[0]!.actor!.items[0]!.screenshotRef).toMatchObject({
      path: "screenshots/frame.png",
      redaction: "blurred",
    });
    const transformed = PNG.sync.read(
      await readFile(path.join(derivative.physicalRunRoot, "screenshots/frame.png")),
    );
    expect([transformed.width, transformed.height]).toEqual([96, 60]);
    expect(
      await readFile(path.join(derivative.physicalRunRoot, "analysis/legacy-notes.txt"), "utf8"),
    ).toBe("Synthetic retained evidence.");
    for (const relative of generatedPaths)
      await expect(access(path.join(derivative.physicalRunRoot, relative))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect((await loadStudyAnalysis(derivative)).state).toBe("none");
    expect((await verifyRun(shared, runId)).shareSafety.status).toBe("share_ready");
    for (let index = 0; index < sourcePaths.length; index++) {
      expect(await readFile(path.join(root, sourcePaths[index]!))).toEqual(originals[index]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("refuses to export a frame a trace registers outside screenshots/", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-export-"));
  const runId = "synthetic-analysis-frame";
  try {
    await runDryRun({ cwd, dryRun: true, runId });
    const root = (await resolveRunPath(cwd, runId))!.physicalRunRoot;
    await mkdir(path.join(root, "analysis"));
    await writeFile(
      path.join(root, "analysis", "frame.png"),
      PNG.sync.write(new PNG({ width: 4, height: 4 })),
    );
    const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
    Object.assign(bundle.streams[0]!, {
      actor: {
        schema: ACTOR_TRACE_SCHEMA,
        redaction: { status: "passed", screenshots: "raw", notes: "Synthetic fixture." },
        items: [
          {
            id: "frame",
            kind: "screenshot",
            lifecycle: "completed",
            title: "Observed frame",
            screenshotRef: { path: "analysis/frame.png", redaction: "none" },
          },
        ],
      },
    });
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
    const verified = await verifyRun(cwd, runId);
    expect(verified.shareSafety.status).toBe("local_only");
    expect(
      verified.shareSafety.reasons.find((reason) => reason.code === "UNSCANNED_ARTIFACT")?.message,
    ).toContain("analysis/frame.png");
    const result = await exportRun(cwd, runId, {
      format: "bundle",
      redactScreenshots: true,
      out: "shared",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("Actor screenshot reference must resolve");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
