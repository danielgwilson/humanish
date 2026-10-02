// Execution receipts: the start record written before a provider request and the receipt
// written after it, plus the accounting read over them and legacy analysis records.

import path from "node:path";

import { runIdOf, type PreparedRunArtifactPaths } from "../run/paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectoryRoot,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import { pathMissing, readBoundedStudyFile } from "../run/study-files.js";
import {
  ANALYSIS_MAX_BYTES,
  MAX_VERSIONS,
  ANALYSIS_DIRECTORY,
  ANALYSIS_EXECUTION_DIRECTORY,
  claimDirectory,
  directoryIds,
  existingRoot,
  safeId,
} from "./store.js";
import {
  hashAnalysisValue,
  analysisExecutionStartSchema,
  validateAnalysisArtifact,
  validateAnalysisExecutionReceipt,
  type AnalysisExecutionReceipt,
  type AnalysisExecutionStart,
} from "./validation.js";
import type { AnalysisArtifact } from "./types.js";

/** receipt.json and start.json in an execution directory. */
const MAX_EXECUTION_RECORD_BYTES = 16 * 1024;
const EXECUTION_BINDING_KEYS = [
  "id",
  "runId",
  "sourceRunSha256",
  "inputDigest",
  "configDigest",
  "promptVersion",
] as const;

/** Exact bounded receipt lookup for an already claimed execution, never a dispatch decision. */
export async function readAnalysisExecution(
  prepared: PreparedRunArtifactPaths,
  id: string,
): Promise<AnalysisExecutionReceipt | null> {
  if (!safeId(id)) return null;
  try {
    const root = await existingRoot(prepared, ANALYSIS_EXECUTION_DIRECTORY);
    if (!root) return null;
    const bytes = await readBoundedStudyFile(
      root,
      `${id}/receipt.json`,
      MAX_EXECUTION_RECORD_BYTES,
    );
    if (!bytes) return null;
    const receipt = validateAnalysisExecutionReceipt(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return receipt.id === id && receipt.runId === runIdOf(prepared) ? receipt : null;
  } catch {
    return null;
  }
}

/**
 * Publish accounting first. Unlike a usable report, this receipt does not claim
 * the source still matches; its digests name the exact input that was attempted.
 */
export async function writeAnalysisExecutionReceipt(
  prepared: PreparedRunArtifactPaths,
  value: AnalysisArtifact,
): Promise<void> {
  const receipt = executionReceipt(value, prepared);
  const root = await prepareContainedOutputDirectoryRoot(prepared, ANALYSIS_EXECUTION_DIRECTORY);
  const claimed = await claimDirectory(root, receipt.id);
  await writeContainedOutputFile(claimed, "receipt.json", `${JSON.stringify(receipt, null, 2)}\n`);
}

function executionReceipt(
  value: AnalysisArtifact,
  prepared: PreparedRunArtifactPaths,
): AnalysisExecutionReceipt {
  const artifact = validateAnalysisArtifact(value);
  if (artifact.runId !== runIdOf(prepared)) throw new Error("ANALYSIS_ID_MISMATCH");
  const receipt: AnalysisExecutionReceipt = {
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
    error: artifact.error,
  };
  return receipt;
}

/** The returned closure owns one exact directory; persisted IDs never authorize overwriting it. */
export async function beginAnalysisExecution(
  prepared: PreparedRunArtifactPaths,
  context: Omit<AnalysisExecutionStart, "schema" | "createdAt">,
): Promise<(value: AnalysisArtifact) => Promise<void>> {
  const start = analysisExecutionStartSchema.parse({
    ...context,
    schema: "humanish.analysis-execution-start.v1",
    createdAt: new Date().toISOString(),
  });
  if (start.runId !== runIdOf(prepared)) throw new Error("ANALYSIS_ID_MISMATCH");
  const root = await prepareContainedOutputDirectoryRoot(prepared, ANALYSIS_EXECUTION_DIRECTORY);
  const claimed = await claimDirectory(root, start.id);
  await writeContainedOutputFile(claimed, "start.json", `${JSON.stringify(start, null, 2)}\n`);
  let finalized = false;
  return async (value) => {
    const receipt = executionReceipt(value, prepared);
    if (finalized || EXECUTION_BINDING_KEYS.some((key) => receipt[key] !== start[key])) {
      throw new Error("ANALYSIS_ID_MISMATCH");
    }
    finalized = true;
    await assertPreparedSelectedOutputDirectory(claimed);
    if (!(await pathMissing(path.join(claimed.physicalPath, "receipt.json"))))
      throw new Error("ANALYSIS_ID_EXISTS");
    await writeContainedOutputFile(
      claimed,
      "receipt.json",
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  };
}

export async function listAnalysisExecutions(prepared: PreparedRunArtifactPaths): Promise<{
  receipts: AnalysisExecutionReceipt[];
  warnings: string[];
}> {
  const receipts: AnalysisExecutionReceipt[] = [];
  const warnings: string[] = [];
  try {
    const root = await existingRoot(prepared, ANALYSIS_EXECUTION_DIRECTORY);
    if (!root) return { receipts, warnings };
    const inventory = await directoryIds(root, MAX_VERSIONS);
    warnings.push(...inventory.warnings);
    for (const id of inventory.ids) {
      const bytes = await readBoundedStudyFile(
        root,
        `${id}/receipt.json`,
        MAX_EXECUTION_RECORD_BYTES,
      );
      if (!bytes) {
        if (
          !(await pathMissing(path.join(root.physicalPath, id, "receipt.json")).catch(() => false))
        )
          warnings.push("ANALYSIS_RECEIPT_UNREADABLE");
        continue;
      }
      try {
        const receipt = validateAnalysisExecutionReceipt(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        if (receipt.id !== id || receipt.runId !== runIdOf(prepared)) {
          warnings.push("ANALYSIS_RECEIPT_INVALID");
          continue;
        }
        receipts.push(receipt);
      } catch {
        warnings.push("ANALYSIS_RECEIPT_INVALID");
      }
    }
    receipts.sort(
      (a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || b.id.localeCompare(a.id),
    );
  } catch {
    warnings.push("ANALYSIS_RECEIPTS_UNAVAILABLE");
  }
  return { receipts, warnings: [...new Set(warnings)] };
}

export interface AnalysisAccountingRecord {
  id: string;
  receipt: AnalysisExecutionReceipt | null;
  start: AnalysisExecutionStart | null;
  legacy: boolean;
}

/** Accounting is independent of source freshness and findings validation. No evidence is opened. */
export async function readAnalysisAccountingRecords(prepared: PreparedRunArtifactPaths): Promise<{
  records: AnalysisAccountingRecord[];
  warnings: string[];
}> {
  const records = new Map<string, AnalysisAccountingRecord>();
  const warnings: string[] = [];
  for (const directory of [ANALYSIS_EXECUTION_DIRECTORY, ANALYSIS_DIRECTORY]) {
    try {
      const root = await existingRoot(prepared, directory);
      if (!root) continue;
      const inventory = await directoryIds(root, MAX_VERSIONS, directory === ANALYSIS_DIRECTORY);
      warnings.push(...inventory.warnings);
      for (const id of inventory.ids) {
        let record = records.get(id);
        if (!record) {
          record = { id, receipt: null, start: null, legacy: false };
          records.set(id, record);
        }
        if (directory === ANALYSIS_EXECUTION_DIRECTORY) {
          const startBytes = await readBoundedStudyFile(
            root,
            `${id}/start.json`,
            MAX_EXECUTION_RECORD_BYTES,
          );
          if (startBytes) {
            try {
              const start = analysisExecutionStartSchema.parse(
                JSON.parse(startBytes.toString("utf8")),
              );
              if (start.id !== id || start.runId !== runIdOf(prepared)) throw new Error();
              record.start = start;
            } catch {
              warnings.push("ANALYSIS_START_INVALID");
            }
          }
        }
        const legacy = directory === ANALYSIS_DIRECTORY;
        const bytes = await readBoundedStudyFile(
          root,
          `${id}/${legacy ? "analysis.json" : "receipt.json"}`,
          legacy ? ANALYSIS_MAX_BYTES : MAX_EXECUTION_RECORD_BYTES,
        );
        if (!bytes) continue;
        try {
          const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (legacy && raw.schema !== "humanish.study-analysis.v1") throw new Error();
          // A historical report may have stale captures or invalid findings. Its strictly checked
          // accounting metadata still records incurred usage; it never approves those findings.
          const candidate = legacy
            ? Object.fromEntries(
                Object.keys(analysisExecutionReceiptKeys).map((key) => [key, raw[key]]),
              )
            : raw;
          if (legacy)
            Object.assign(candidate, {
              schema: "humanish.analysis-execution.v1",
              model: raw.config?.model,
              maxCostUsd: raw.config?.maxCostUsd,
            });
          const receipt = validateAnalysisExecutionReceipt(candidate);
          if (receipt.id !== id || receipt.runId !== runIdOf(prepared)) throw new Error();
          if (record.receipt && hashAnalysisValue(record.receipt) !== hashAnalysisValue(receipt)) {
            warnings.push("ANALYSIS_ACCOUNTING_CONFLICT");
            record.receipt = null;
          } else {
            record.legacy = legacy && record.receipt === null;
            record.receipt = receipt;
          }
        } catch {
          warnings.push("ANALYSIS_ACCOUNTING_INVALID");
        }
      }
    } catch {
      warnings.push("ANALYSIS_ACCOUNTING_UNAVAILABLE");
    }
  }
  for (const record of records.values()) {
    if (
      record.start &&
      record.receipt &&
      EXECUTION_BINDING_KEYS.some((key) => record.start![key] !== record.receipt![key])
    ) {
      warnings.push("ANALYSIS_ACCOUNTING_CONFLICT");
      record.receipt = null;
    }
  }
  return { records: [...records.values()], warnings: [...new Set(warnings)] };
}

const analysisExecutionReceiptKeys = {
  id: true,
  runId: true,
  status: true,
  createdAt: true,
  completedAt: true,
  sourceRunSha256: true,
  inputDigest: true,
  configDigest: true,
  promptVersion: true,
  provider: true,
  usage: true,
  error: true,
};
