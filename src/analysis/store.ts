import { createHash } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import path from "node:path";
import {
  physicalCwdOf,
  runIdOf,
  validatePreparedRunRootIdentity,
  type PreparedRunArtifactPaths,
} from "../run/paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  prepareContainedOutputDirectoryRoot,
  writeContainedOutputFile,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";
import { STUDY_EVIDENCE_LIMITS, validateStudyAnalysisEvidence } from "./evidence.js";
import { pathMissing, isStudyEvidencePath, readBoundedStudyFile } from "../run/study-files.js";
import {
  hashStudyAnalysisValue,
  validateStudyAnalysisArtifact,
  validateStudyAnalysisCorrection,
} from "./validation.js";
import {
  ANALYSIS_ID_PATTERN,
  type LoadedStudyAnalysis,
  type StudyAnalysisArtifact,
  type StudyAnalysisCorrection,
} from "./study-analysis.js";
import { RUN_BUNDLE_FILE } from "../run/bundle.js";

export const STUDY_ANALYSIS_DIRECTORY = "analysis";
export const STUDY_ANALYSIS_EXECUTION_DIRECTORY = "analysis-attempts";
export const ANALYSIS_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_VERSIONS = 256;
const MAX_CORRECTIONS = 256;
const MAX_CORRECTION_BYTES = 32 * 1024;
export const safeId = (value: string): boolean => ANALYSIS_ID_PATTERN.test(value);
const hashBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const empty = (
  state: LoadedStudyAnalysis["state"],
  warnings: string[] = [],
): LoadedStudyAnalysis => ({ state, analysis: null, corrections: [], warnings });

export interface StudyAnalysisListEntry {
  id: string;
  state: "ready" | "stale" | "invalid";
  analysis: StudyAnalysisArtifact | null;
  warnings: string[];
}

/** Check room for both immutable publications before a new provider dispatch.
 * This is read-only; the service's dispatch lock protects ordinary concurrent writers. */
export async function assertStudyAnalysisPublicationCapacity(
  prepared: PreparedRunArtifactPaths,
): Promise<void> {
  try {
    for (const directory of [STUDY_ANALYSIS_DIRECTORY, STUDY_ANALYSIS_EXECUTION_DIRECTORY]) {
      const root = await existingRoot(prepared, directory);
      if (!root) continue;
      const inventory = await directoryIds(
        root,
        MAX_VERSIONS - 1,
        directory === STUDY_ANALYSIS_DIRECTORY,
      );
      if (inventory.warnings.length > 0) throw new Error("Unsafe analysis inventory.");
    }
  } catch {
    throw new Error("ANALYSIS_HISTORY_UNAVAILABLE");
  }
}

export async function existingRoot(
  prepared: PreparedRunArtifactPaths,
  directory = STUDY_ANALYSIS_DIRECTORY,
): Promise<PreparedSelectedOutputDirectory | null> {
  await validatePreparedRunRootIdentity(prepared);
  const cwd = physicalCwdOf(prepared);
  const root = await bindExistingManagedHumanishOutputDirectory(
    cwd,
    "runs",
    runIdOf(prepared),
    directory,
  );
  return root ? Object.freeze({ ...root, parentRun: prepared }) : null;
}

export async function claimDirectory(
  parent: PreparedSelectedOutputDirectory,
  id: string,
): Promise<PreparedSelectedOutputDirectory> {
  if (!safeId(id)) throw new Error("ANALYSIS_ID_INVALID");
  await assertPreparedSelectedOutputDirectory(parent);
  try {
    await mkdir(path.join(parent.physicalPath, id), { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("ANALYSIS_ID_EXISTS");
    throw new Error("ANALYSIS_STORAGE_UNAVAILABLE");
  }
  await assertPreparedSelectedOutputDirectory(parent);
  return prepareContainedOutputDirectoryRoot(parent, id);
}

/** A claimed version is never reused, including after interruption before publication. */
export async function writeStudyAnalysis(
  prepared: PreparedRunArtifactPaths,
  value: StudyAnalysisArtifact,
): Promise<void> {
  const artifact = validateStudyAnalysisArtifact(value);
  const source = await readBoundedStudyFile(
    prepared,
    RUN_BUNDLE_FILE,
    STUDY_EVIDENCE_LIMITS.sourceBytes,
  );
  if (!source) throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
  await validateStudyAnalysisEvidence(prepared, artifact, source);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (bytes.length > ANALYSIS_MAX_BYTES) throw new Error("ANALYSIS_ARTIFACT_TOO_LARGE");
  const root = await prepareContainedOutputDirectoryRoot(prepared, STUDY_ANALYSIS_DIRECTORY);
  const claimed = await claimDirectory(root, artifact.id);
  // Recheck source immediately before publishing the immutable record.
  const current = await readBoundedStudyFile(
    prepared,
    RUN_BUNDLE_FILE,
    STUDY_EVIDENCE_LIMITS.sourceBytes,
  );
  if (!current?.equals(source)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  await writeContainedOutputFile(claimed, "analysis.json", bytes);
}

export async function directoryIds(
  root: PreparedSelectedOutputDirectory,
  limit: number,
  ignoreLegacyFiles = false,
): Promise<{ ids: string[]; warnings: string[] }> {
  await assertPreparedSelectedOutputDirectory(root);
  const directory = await opendir(root.physicalPath);
  const ids: string[] = [];
  const warnings: string[] = [];
  let count = 0;
  for await (const entry of directory) {
    if (++count > limit) throw new Error("ANALYSIS_INVENTORY_LIMIT");
    const stats = await lstat(path.join(root.physicalPath, entry.name)).catch(() => null);
    if (!stats) continue;
    if (
      stats.isSymbolicLink() ||
      (!stats.isDirectory() && !stats.isFile()) ||
      (stats.isFile() && stats.nlink !== 1)
    ) {
      warnings.push("ANALYSIS_UNSAFE_ENTRY_IGNORED");
      continue;
    }
    if (stats.isFile()) {
      if (entry.name.startsWith(".humanish-write-")) continue;
      if (
        ignoreLegacyFiles &&
        isStudyEvidencePath(entry.name) &&
        !["analysis.json", "correction.json", "receipt.json"].includes(entry.name)
      )
        continue;
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
  source: Buffer | null,
): Promise<StudyAnalysisListEntry | null> {
  if (!safeId(id))
    return { id: "invalid", state: "invalid", analysis: null, warnings: ["ANALYSIS_ID_INVALID"] };
  const bytes = await readBoundedStudyFile(root, `${id}/analysis.json`, ANALYSIS_MAX_BYTES);
  // A claimed directory without a published record is an interrupted write, not a report.
  if (bytes === null) {
    if (await pathMissing(path.join(root.physicalPath, id, "analysis.json")).catch(() => false))
      return null;
    return { id, state: "invalid", analysis: null, warnings: ["ANALYSIS_ARTIFACT_UNREADABLE"] };
  }
  let analysis: StudyAnalysisArtifact;
  try {
    analysis = validateStudyAnalysisArtifact(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (analysis.id !== id || analysis.runId !== runIdOf(prepared))
      throw new Error("ANALYSIS_ID_MISMATCH");
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
    return {
      id,
      state: stale ? "stale" : "invalid",
      analysis: null,
      warnings: [stale ? "ANALYSIS_CAPTURE_CHANGED" : "ANALYSIS_EVIDENCE_INVALID"],
    };
  }
  if (analysis.result === null)
    return {
      id,
      state: "invalid",
      analysis,
      warnings: [analysis.status === "cancelled" ? "ANALYSIS_CANCELLED" : "ANALYSIS_FAILED"],
    };
  return { id, state: "ready", analysis, warnings: [] };
}

/** Read one exact result without reading automatic job state or unrelated history. */
export async function readStudyAnalysisVersion(
  prepared: PreparedRunArtifactPaths,
  id: string,
): Promise<StudyAnalysisListEntry | null> {
  if (!safeId(id)) return null;
  try {
    const root = await existingRoot(prepared);
    if (!root) return null;
    return await readVersion(
      prepared,
      root,
      id,
      await readBoundedStudyFile(prepared, RUN_BUNDLE_FILE, STUDY_EVIDENCE_LIMITS.sourceBytes),
    );
  } catch {
    return null;
  }
}

/** Includes failed attempts; callers must not equate the newest attempt with usable findings. */
export async function listStudyAnalyses(
  prepared: PreparedRunArtifactPaths,
): Promise<StudyAnalysisListEntry[]> {
  try {
    const root = await existingRoot(prepared);
    if (!root) return [];
    const inventory = await directoryIds(root, MAX_VERSIONS, true);
    const source = await readBoundedStudyFile(
      prepared,
      RUN_BUNDLE_FILE,
      STUDY_EVIDENCE_LIMITS.sourceBytes,
    );
    const results: StudyAnalysisListEntry[] = [];
    for (const id of inventory.ids) {
      const entry = await readVersion(prepared, root, id, source);
      if (entry) results.push(entry);
    }
    if (inventory.warnings.length)
      results.push({
        id: "invalid",
        state: "invalid",
        analysis: null,
        warnings: inventory.warnings,
      });
    return results.sort(
      (a, b) =>
        (Date.parse(b.analysis?.completedAt ?? "") || 0) -
          (Date.parse(a.analysis?.completedAt ?? "") || 0) || b.id.localeCompare(a.id),
    );
  } catch {
    return [
      {
        id: "invalid",
        state: "invalid",
        analysis: null,
        warnings: ["ANALYSIS_STORAGE_UNAVAILABLE"],
      },
    ];
  }
}

async function readCorrections(
  prepared: PreparedRunArtifactPaths,
  root: PreparedSelectedOutputDirectory,
  analysis: StudyAnalysisArtifact,
): Promise<{ corrections: StudyAnalysisCorrection[]; warnings: string[] }> {
  const corrections: StudyAnalysisCorrection[] = [];
  const warnings: string[] = [];
  try {
    const cwd = physicalCwdOf(prepared);
    const directory = await bindExistingManagedHumanishOutputDirectory(
      cwd,
      "runs",
      analysis.runId,
      STUDY_ANALYSIS_DIRECTORY,
      analysis.id,
      "corrections",
    );
    if (!directory) return { corrections, warnings };
    const bound = Object.freeze({ ...directory, parentRun: prepared });
    const inventory = await directoryIds(bound, MAX_CORRECTIONS);
    warnings.push(...inventory.warnings);
    for (const id of inventory.ids) {
      const bytes = await readBoundedStudyFile(
        root,
        `${analysis.id}/corrections/${id}/correction.json`,
        MAX_CORRECTION_BYTES,
      );
      if (!bytes) {
        // An unpublished claim directory is harmless; a present record that
        // cannot be checked must not silently erase a prior review decision.
        const correctionPath = path.join(
          root.physicalPath,
          analysis.id,
          "corrections",
          id,
          "correction.json",
        );
        if (!(await pathMissing(correctionPath).catch(() => false)))
          warnings.push("ANALYSIS_CORRECTION_UNREADABLE");
        continue;
      }
      try {
        const correction = validateStudyAnalysisCorrection(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        assertCorrectionBinding(analysis, correction);
        if (correction.id !== id) throw new Error("ANALYSIS_CORRECTION_ID_INVALID");
        corrections.push(correction);
      } catch {
        warnings.push("ANALYSIS_CORRECTION_INVALID");
      }
    }
  } catch {
    warnings.push("ANALYSIS_CORRECTIONS_UNAVAILABLE");
  }
  corrections.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { corrections, warnings };
}

export async function loadStudyAnalysisRecord(
  prepared: PreparedRunArtifactPaths,
  id?: string,
): Promise<LoadedStudyAnalysis> {
  if (id !== undefined && !safeId(id)) return empty("invalid", ["ANALYSIS_ID_INVALID"]);
  try {
    const versions = await listStudyAnalyses(prepared);
    const selected =
      id === undefined
        ? (versions.find((entry) => entry.state === "ready") ??
          versions.find((entry) => entry.state === "stale") ??
          versions[0])
        : versions.find((entry) => entry.id === id);
    if (!selected) return empty("none");
    const warnings = [...selected.warnings];
    if (id === undefined)
      for (const entry of versions) if (entry !== selected) warnings.push(...entry.warnings);
    if (!selected.analysis || selected.state !== "ready") {
      return { ...empty(selected.state, [...new Set(warnings)]), analysis: selected.analysis };
    }
    const root = await existingRoot(prepared);
    if (!root) return empty("invalid", ["ANALYSIS_STORAGE_UNAVAILABLE"]);
    const corrections = await readCorrections(prepared, root, selected.analysis);
    return {
      state: "ready",
      analysis: selected.analysis,
      corrections: corrections.corrections,
      warnings: [...new Set([...warnings, ...corrections.warnings])],
    };
  } catch {
    return empty("invalid", ["ANALYSIS_STORAGE_UNAVAILABLE"]);
  }
}

function assertCorrectionBinding(
  analysis: StudyAnalysisArtifact,
  correction: StudyAnalysisCorrection,
): void {
  const finding = analysis.result?.findings.find((entry) => entry.id === correction.findingId);
  if (
    analysis.id !== correction.analysisId ||
    hashStudyAnalysisValue(analysis) !== correction.analysisSha256 ||
    !finding ||
    hashStudyAnalysisValue(finding) !== correction.findingSha256 ||
    Date.parse(correction.createdAt) < Date.parse(analysis.completedAt)
  )
    throw new Error("ANALYSIS_CORRECTION_BINDING_INVALID");
}

export async function appendStudyAnalysisCorrection(
  prepared: PreparedRunArtifactPaths,
  value: StudyAnalysisCorrection,
): Promise<void> {
  const correction = validateStudyAnalysisCorrection(value);
  const loaded = await loadStudyAnalysisRecord(prepared, correction.analysisId);
  if (loaded.state !== "ready" || !loaded.analysis)
    throw new Error("ANALYSIS_CORRECTION_SOURCE_UNAVAILABLE");
  assertCorrectionBinding(loaded.analysis, correction);
  const root = await existingRoot(prepared);
  if (!root) throw new Error("ANALYSIS_STORAGE_UNAVAILABLE");
  const parent = await prepareContainedOutputDirectoryRoot(
    root,
    `${correction.analysisId}/corrections`,
  );
  // The service's run lock serializes this check with ordinary correction writers.
  // Reserve the new entry before claiming it so a full history stays readable.
  try {
    const inventory = await directoryIds(parent, MAX_CORRECTIONS - 1);
    if (inventory.warnings.length > 0) throw new Error("Unsafe correction inventory.");
  } catch {
    throw new Error("ANALYSIS_CORRECTION_HISTORY_UNAVAILABLE");
  }
  const claimed = await claimDirectory(parent, correction.id);
  await writeContainedOutputFile(
    claimed,
    "correction.json",
    `${JSON.stringify(correction, null, 2)}\n`,
  );
}
