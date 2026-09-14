import { createHash } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import path from "node:path";
import {
  validatePreparedRunRootIdentity,
  type PreparedRunArtifactPaths
} from "./run-paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  prepareContainedOutputDirectoryRoot,
  writeContainedOutputFile,
  type PreparedSelectedOutputDirectory
} from "./selected-output-paths.js";
import {
  isStudyEvidencePath,
  readBoundedStudyFile,
  STUDY_EVIDENCE_LIMITS,
  validateStudyAnalysisEvidence
} from "./study-analysis-evidence.js";
import {
  hashStudyAnalysisValue,
  validateStudyAnalysisExecutionReceipt,
  type StudyAnalysisExecutionReceipt,
  validateStudyAnalysisArtifact,
  validateStudyAnalysisCorrection
} from "./study-analysis-validation.js";
import type { LoadedStudyAnalysis, StudyAnalysisArtifact, StudyAnalysisCorrection } from "./study-analysis.js";

export const STUDY_ANALYSIS_DIRECTORY = "analysis";
const ANALYSIS_MAX_BYTES = 4 * 1024 * 1024;
const MAX_VERSIONS = 256;
const MAX_CORRECTIONS = 256;
const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const hashBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const empty = (state: LoadedStudyAnalysis["state"], warnings: string[] = []): LoadedStudyAnalysis =>
  ({ state, analysis: null, corrections: [], warnings });

export interface StudyAnalysisListEntry {
  id: string;
  state: "ready" | "stale" | "invalid";
  analysis: StudyAnalysisArtifact | null;
  warnings: string[];
}

async function existingRoot(prepared: PreparedRunArtifactPaths, directory = STUDY_ANALYSIS_DIRECTORY): Promise<PreparedSelectedOutputDirectory | null> {
  await validatePreparedRunRootIdentity(prepared);
  const cwd = path.dirname(path.dirname(path.dirname(prepared.absoluteRunRoot)));
  const root = await bindExistingManagedHumanishOutputDirectory(cwd, "runs", path.basename(prepared.absoluteRunRoot), directory);
  return root ? Object.freeze({ ...root, parentRun: prepared }) : null;
}

async function claimDirectory(parent: PreparedSelectedOutputDirectory, id: string): Promise<PreparedSelectedOutputDirectory> {
  if (!safeId(id)) throw new Error("ANALYSIS_ID_INVALID");
  await assertPreparedSelectedOutputDirectory(parent);
  try {
    await mkdir(path.join(parent.physicalPath, id), { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("ANALYSIS_ID_EXISTS");
    throw new Error("ANALYSIS_STORAGE_UNAVAILABLE");
  }
  await assertPreparedSelectedOutputDirectory(parent);
  return prepareContainedOutputDirectoryRoot(parent, id);
}

/** A claimed version is never reused, including after interruption before publication. */
export async function writeStudyAnalysis(prepared: PreparedRunArtifactPaths, value: StudyAnalysisArtifact): Promise<void> {
  const artifact = validateStudyAnalysisArtifact(value);
  const source = await readBoundedStudyFile(prepared, "run.json", STUDY_EVIDENCE_LIMITS.sourceBytes);
  if (!source) throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
  await validateStudyAnalysisEvidence(prepared, artifact, source);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (bytes.length > ANALYSIS_MAX_BYTES) throw new Error("ANALYSIS_ARTIFACT_TOO_LARGE");
  const root = await prepareContainedOutputDirectoryRoot(prepared, STUDY_ANALYSIS_DIRECTORY);
  const claimed = await claimDirectory(root, artifact.id);
  // Recheck source immediately before publishing the immutable record.
  const current = await readBoundedStudyFile(prepared, "run.json", STUDY_EVIDENCE_LIMITS.sourceBytes);
  if (!current?.equals(source)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  await writeContainedOutputFile(claimed, "analysis.json", bytes);
}

async function directoryIds(root: PreparedSelectedOutputDirectory, limit: number, ignoreLegacyFiles = false): Promise<{ ids: string[]; warnings: string[] }> {
  await assertPreparedSelectedOutputDirectory(root);
  const directory = await opendir(root.physicalPath);
  const ids: string[] = [];
  const warnings: string[] = [];
  let count = 0;
  for await (const entry of directory) {
    if (++count > limit) throw new Error("ANALYSIS_INVENTORY_LIMIT");
    const stats = await lstat(path.join(root.physicalPath, entry.name)).catch(() => null);
    if (!stats) continue;
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink !== 1)) {
      warnings.push("ANALYSIS_UNSAFE_ENTRY_IGNORED");
      continue;
    }
    if (stats.isFile()) {
      if (entry.name.startsWith(".humanish-write-")) continue;
      if (ignoreLegacyFiles && isStudyEvidencePath(entry.name)
        && !["analysis.json", "correction.json", "receipt.json"].includes(entry.name)) continue;
      warnings.push("ANALYSIS_UNSAFE_ENTRY_IGNORED");
      continue;
    }
    if (!safeId(entry.name)) {
      warnings.push("ANALYSIS_UNSAFE_ENTRY_IGNORED");
      continue;
    }
    ids.push(entry.name);
  }
  await assertPreparedSelectedOutputDirectory(root);
  return { ids: ids.sort(), warnings };
}

async function readVersion(
  prepared: PreparedRunArtifactPaths,
  root: PreparedSelectedOutputDirectory,
  id: string,
  source: Buffer | null
): Promise<StudyAnalysisListEntry | null> {
  if (!safeId(id)) return { id: "invalid", state: "invalid", analysis: null, warnings: ["ANALYSIS_ID_INVALID"] };
  const bytes = await readBoundedStudyFile(root, `${id}/analysis.json`, ANALYSIS_MAX_BYTES);
  // A claimed directory without a published record is an interrupted write, not a report.
  if (bytes === null) {
    try {
      await lstat(path.join(root.physicalPath, id, "analysis.json"));
      return { id, state: "invalid", analysis: null, warnings: ["ANALYSIS_ARTIFACT_UNREADABLE"] };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      return { id, state: "invalid", analysis: null, warnings: ["ANALYSIS_ARTIFACT_UNREADABLE"] };
    }
  }
  let analysis: StudyAnalysisArtifact;
  try {
    analysis = validateStudyAnalysisArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (analysis.id !== id || analysis.runId !== path.basename(prepared.physicalRunRoot)) throw new Error("ANALYSIS_ID_MISMATCH");
  } catch {
    return { id, state: "invalid", analysis: null, warnings: ["ANALYSIS_ARTIFACT_INVALID"] };
  }
  if (!source || hashBytes(source) !== analysis.sourceRunSha256) {
    return { id, state: "stale", analysis, warnings: ["ANALYSIS_SOURCE_CHANGED"] };
  }
  try {
    await validateStudyAnalysisEvidence(prepared, analysis, source);
  } catch (error) {
    const stale = error instanceof Error && error.message === "ANALYSIS_CAPTURE_CHANGED";
    return { id, state: stale ? "stale" : "invalid", analysis: null,
      warnings: [stale ? "ANALYSIS_CAPTURE_CHANGED" : "ANALYSIS_EVIDENCE_INVALID"] };
  }
  if (analysis.result === null) return { id, state: "invalid", analysis,
    warnings: [analysis.status === "cancelled" ? "ANALYSIS_CANCELLED" : "ANALYSIS_FAILED"] };
  return { id, state: "ready", analysis, warnings: [] };
}

/** Includes failed attempts; callers must not equate the newest attempt with usable findings. */
export async function listStudyAnalyses(prepared: PreparedRunArtifactPaths): Promise<StudyAnalysisListEntry[]> {
  try {
    const root = await existingRoot(prepared);
    if (!root) return [];
    const inventory = await directoryIds(root, MAX_VERSIONS, true);
    const source = await readBoundedStudyFile(prepared, "run.json", STUDY_EVIDENCE_LIMITS.sourceBytes);
    const results: StudyAnalysisListEntry[] = [];
    for (const id of inventory.ids) {
      const entry = await readVersion(prepared, root, id, source);
      if (entry) results.push(entry);
    }
    if (inventory.warnings.length) results.push({ id: "invalid", state: "invalid", analysis: null, warnings: inventory.warnings });
    return results.sort((a, b) => (Date.parse(b.analysis?.completedAt ?? "") || 0) - (Date.parse(a.analysis?.completedAt ?? "") || 0) || b.id.localeCompare(a.id));
  } catch {
    return [{ id: "invalid", state: "invalid", analysis: null, warnings: ["ANALYSIS_STORAGE_UNAVAILABLE"] }];
  }
}

async function readCorrections(
  prepared: PreparedRunArtifactPaths,
  root: PreparedSelectedOutputDirectory,
  analysis: StudyAnalysisArtifact
): Promise<{ corrections: StudyAnalysisCorrection[]; warnings: string[] }> {
  const corrections: StudyAnalysisCorrection[] = [];
  const warnings: string[] = [];
  try {
    const cwd = path.dirname(path.dirname(path.dirname(prepared.absoluteRunRoot)));
    const directory = await bindExistingManagedHumanishOutputDirectory(cwd, "runs", analysis.runId,
      STUDY_ANALYSIS_DIRECTORY, analysis.id, "corrections");
    if (!directory) return { corrections, warnings };
    const bound = Object.freeze({ ...directory, parentRun: prepared });
    const inventory = await directoryIds(bound, MAX_CORRECTIONS);
    warnings.push(...inventory.warnings);
    for (const id of inventory.ids) {
      const bytes = await readBoundedStudyFile(root, `${analysis.id}/corrections/${id}/correction.json`, 32 * 1024);
      if (!bytes) continue;
      try {
        const correction = validateStudyAnalysisCorrection(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        assertCorrectionBinding(analysis, correction);
        if (correction.id !== id) throw new Error("ANALYSIS_CORRECTION_ID_INVALID");
        corrections.push(correction);
      } catch { warnings.push("ANALYSIS_CORRECTION_INVALID"); }
    }
  } catch { warnings.push("ANALYSIS_CORRECTIONS_UNAVAILABLE"); }
  corrections.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { corrections, warnings };
}

export async function loadStudyAnalysis(prepared: PreparedRunArtifactPaths, id?: string): Promise<LoadedStudyAnalysis> {
  if (id !== undefined && !safeId(id)) return empty("invalid", ["ANALYSIS_ID_INVALID"]);
  try {
    const versions = await listStudyAnalyses(prepared);
    const selected = id === undefined
      ? versions.find((entry) => entry.state === "ready") ?? versions.find((entry) => entry.state === "stale") ?? versions[0]
      : versions.find((entry) => entry.id === id);
    if (!selected) return empty("none");
    const warnings = [...selected.warnings];
    if (id === undefined) for (const entry of versions) if (entry !== selected) warnings.push(...entry.warnings);
    if (!selected.analysis || selected.state !== "ready") {
      return { ...empty(selected.state, [...new Set(warnings)]), analysis: selected.analysis };
    }
    const root = await existingRoot(prepared);
    if (!root) return empty("invalid", ["ANALYSIS_STORAGE_UNAVAILABLE"]);
    const corrections = await readCorrections(prepared, root, selected.analysis);
    return { state: "ready", analysis: selected.analysis, corrections: corrections.corrections,
      warnings: [...new Set([...warnings, ...corrections.warnings])] };
  } catch { return empty("invalid", ["ANALYSIS_STORAGE_UNAVAILABLE"]); }
}

function assertCorrectionBinding(analysis: StudyAnalysisArtifact, correction: StudyAnalysisCorrection): void {
  const finding = analysis.result?.findings.find((entry) => entry.id === correction.findingId);
  if (analysis.id !== correction.analysisId || hashStudyAnalysisValue(analysis) !== correction.analysisSha256
    || !finding || hashStudyAnalysisValue(finding) !== correction.findingSha256
    || Date.parse(correction.createdAt) < Date.parse(analysis.completedAt)) throw new Error("ANALYSIS_CORRECTION_BINDING_INVALID");
}

export async function appendStudyAnalysisCorrection(
  prepared: PreparedRunArtifactPaths,
  value: StudyAnalysisCorrection
): Promise<void> {
  const correction = validateStudyAnalysisCorrection(value);
  const loaded = await loadStudyAnalysis(prepared, correction.analysisId);
  if (loaded.state !== "ready" || !loaded.analysis) throw new Error("ANALYSIS_CORRECTION_SOURCE_UNAVAILABLE");
  assertCorrectionBinding(loaded.analysis, correction);
  const root = await existingRoot(prepared);
  if (!root) throw new Error("ANALYSIS_STORAGE_UNAVAILABLE");
  const parent = await prepareContainedOutputDirectoryRoot(root, `${correction.analysisId}/corrections`);
  const claimed = await claimDirectory(parent, correction.id);
  await writeContainedOutputFile(claimed, "correction.json", `${JSON.stringify(correction, null, 2)}\n`);
}

export type { StudyAnalysisExecutionReceipt } from "./study-analysis-validation.js";
export const STUDY_ANALYSIS_EXECUTION_DIRECTORY = "analysis-attempts";

/**
 * Publish accounting first. Unlike a usable report, this receipt does not claim
 * the source still matches; its digests name the exact input that was attempted.
 */
export async function writeStudyAnalysisExecutionReceipt(
  prepared: PreparedRunArtifactPaths,
  value: StudyAnalysisArtifact
): Promise<void> {
  const artifact = validateStudyAnalysisArtifact(value);
  if (artifact.runId !== path.basename(prepared.physicalRunRoot)) throw new Error("ANALYSIS_ID_MISMATCH");
  const receipt: StudyAnalysisExecutionReceipt = {
    schema: "humanish.analysis-execution.v1",
    model: artifact.config.model,
    maxCostUsd: artifact.config.maxCostUsd,
    id: artifact.id,
    runId: artifact.runId,
    status: artifact.status,
    createdAt: artifact.createdAt,
    completedAt: artifact.completedAt,
    sourceRunSha256: artifact.sourceRunSha256,
    inputDigest: artifact.inputDigest,
    configDigest: artifact.configDigest,
    promptVersion: artifact.promptVersion,
    provider: artifact.provider,
    usage: artifact.usage,
    error: artifact.error
  };
  const root = await prepareContainedOutputDirectoryRoot(prepared, STUDY_ANALYSIS_EXECUTION_DIRECTORY);
  const claimed = await claimDirectory(root, receipt.id);
  await writeContainedOutputFile(claimed, "receipt.json", `${JSON.stringify(receipt, null, 2)}\n`);
}

export async function listStudyAnalysisExecutions(prepared: PreparedRunArtifactPaths): Promise<{
  receipts: StudyAnalysisExecutionReceipt[];
  warnings: string[];
}> {
  const receipts: StudyAnalysisExecutionReceipt[] = [];
  const warnings: string[] = [];
  try {
    const root = await existingRoot(prepared, STUDY_ANALYSIS_EXECUTION_DIRECTORY);
    if (!root) return { receipts, warnings };
    const inventory = await directoryIds(root, MAX_VERSIONS);
    warnings.push(...inventory.warnings);
    for (const id of inventory.ids) {
      const bytes = await readBoundedStudyFile(root, `${id}/receipt.json`, 16 * 1024);
      if (!bytes) {
        try {
          await lstat(path.join(root.physicalPath, id, "receipt.json"));
          warnings.push("ANALYSIS_RECEIPT_UNREADABLE");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warnings.push("ANALYSIS_RECEIPT_UNREADABLE");
        }
        continue;
      }
      try {
        const receipt = validateStudyAnalysisExecutionReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (receipt.id !== id || receipt.runId !== path.basename(prepared.physicalRunRoot)) {
          warnings.push("ANALYSIS_RECEIPT_INVALID");
          continue;
        }
        receipts.push(receipt);
      } catch { warnings.push("ANALYSIS_RECEIPT_INVALID"); }
    }
    receipts.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || b.id.localeCompare(a.id));
  } catch { warnings.push("ANALYSIS_RECEIPTS_UNAVAILABLE"); }
  return { receipts, warnings: [...new Set(warnings)] };
}
