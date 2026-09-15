import type { AnalyzeResult } from "./study-analysis-service.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validatePreparedRunRootIdentity, type PreparedRunArtifactPaths } from "./run-paths.js";
import { assertPreparedSelectedOutputDirectory, bindExistingManagedHumanishOutputDirectory,
  prepareContainedOutputDirectoryRoot, writeContainedOutputFile, type PreparedSelectedOutputDirectory } from "./selected-output-paths.js";
import { readBoundedStudyFile } from "./study-analysis-evidence.js";
import { containsSensitive } from "./redaction.js";
import { readStudyAnalysisExecution, readStudyAnalysisVersion } from "./study-analysis-store.js";
import { hashStudyAnalysisValue } from "./study-analysis-validation.js";

export const AUTOMATIC_STUDY_ANALYSIS_DIRECTORY = "analysis-automatic";
export const AUTOMATIC_STUDY_ANALYSIS_SCHEMA = "humanish.automatic-study-analysis.v1";
export const AUTOMATIC_STUDY_ANALYSIS_STALE_MS = 15_000;

/** Execution metadata only. Never a participant outcome or permission to dispatch. */
export interface AutomaticStudyAnalysisView {
  state: "queued" | "running" | "complete" | "partial" | "failed" | "cancelled" | "skipped" | "unknown";
  analysisId: string | null;
  /** Safe stable code, not provider text. */
  reason: string | null;
  updatedAt: string;
}

export interface AutomaticStudyAnalysisOutcome {
  state: "complete" | "partial" | "failed" | "cancelled" | "skipped" | "unknown";
  reason: string | null;
  result?: AnalyzeResult;
}

export interface AutomaticStudyAnalysisCancellation {
  requested: boolean;
  reason: string | null;
}

const JOB_FILE = "job.json";
const CANCEL_FILE = "cancel.json";
const MAX_JOB_BYTES = 8192;
const CANCEL_SCHEMA = "humanish.automatic-study-analysis-cancellation.v1";
const reasons = ["AUTOMATIC_ANALYSIS_ALREADY_REQUESTED", "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE",
  "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN", "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE", "AUTOMATIC_ANALYSIS_KEY_MISSING",
  "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED", "AUTOMATIC_ANALYSIS_BUSY", "AUTOMATIC_ANALYSIS_CANCELLED",
  "AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE", "AUTOMATIC_ANALYSIS_FAILED", "AUTOMATIC_ANALYSIS_PUBLICATION_FAILED",
  "AUTOMATIC_ANALYSIS_REUSED", "AUTOMATIC_ANALYSIS_LIMITATIONS", "AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED",
  "AUTOMATIC_ANALYSIS_ACTOR_CANCELLED", "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE"] as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const date = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema = z.strictObject({
  schema: z.literal(AUTOMATIC_STUDY_ANALYSIS_SCHEMA), runId: id, claimId: z.uuid(), attemptId: id,
  state: z.enum(["queued", "running", "complete", "partial", "failed", "cancelled", "skipped", "unknown"]),
  analysisId: id.nullable(), reason: z.enum(reasons).nullable(), createdAt: date, updatedAt: date,
  configDigest: digest, promptVersion: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  sourceRunSha256: digest.nullable(), inputDigest: digest.nullable(),
  analysisSha256: digest.nullable(), receiptSha256: digest.nullable(),
  startedAt: date.nullable(), finishedAt: date.nullable()
});
type JobRecord = z.infer<typeof jobSchema>;
const cancelSchema = z.strictObject({ schema: z.literal(CANCEL_SCHEMA), runId: id, claimId: z.uuid(), requestedAt: date });
const pending = (state: AutomaticStudyAnalysisView["state"]): boolean => state === "queued" || state === "running";
const iso = (): string => new Date().toISOString();
const unknown = (updatedAt = iso()): AutomaticStudyAnalysisView => ({ state: "unknown", analysisId: null,
  reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN", updatedAt });

function parseJob(bytes: Buffer, runId: string): JobRecord {
  const record = jobSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (containsSensitive(JSON.stringify(record)) || record.runId !== runId || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
    || (pending(record.state) && record.finishedAt !== null)
    || (!pending(record.state) && record.finishedAt === null)
    || (record.analysisId !== null && record.reason !== "AUTOMATIC_ANALYSIS_REUSED" && record.analysisId !== record.attemptId)
    || (record.reason === "AUTOMATIC_ANALYSIS_REUSED" && (!["complete", "partial"].includes(record.state) || record.startedAt !== null || record.analysisId === null))
    || (record.state === "running" && record.startedAt === null)
    || (record.startedAt !== null && Date.parse(record.startedAt) < Date.parse(record.createdAt))
    || (record.finishedAt !== null && Date.parse(record.finishedAt) < Date.parse(record.createdAt))) {
    throw new Error("AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE");
  }
  return record;
}

/** Also guards direct HTML projection callers, not only the contained-file reader. */
export function projectAutomaticStudyAnalysisView(value: unknown): AutomaticStudyAnalysisView | undefined {
  if (value === undefined) return undefined;
  const parsed = jobSchema.pick({ state: true, analysisId: true, reason: true, updatedAt: true }).safeParse(value);
  if (!parsed.success || containsSensitive(JSON.stringify(parsed.data))) return unknown();
  return parsed.data;
}

async function bindJob(prepared: PreparedRunArtifactPaths): Promise<PreparedSelectedOutputDirectory | null> {
  await validatePreparedRunRootIdentity(prepared);
  const cwd = path.dirname(path.dirname(path.dirname(prepared.absoluteRunRoot)));
  const root = await bindExistingManagedHumanishOutputDirectory(cwd, "runs", path.basename(prepared.physicalRunRoot), AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
  return root ? Object.freeze({ ...root, parentRun: prepared }) : null;
}

/** Read-only projection. A stale timestamp or persisted claim never authorizes execution. */
export async function readAutomaticStudyAnalysisPrepared(prepared: PreparedRunArtifactPaths, now = Date.now()): Promise<AutomaticStudyAnalysisView | undefined> {
  try {
    const root = await bindJob(prepared);
    if (!root) {
      const exists = await lstat(path.join(prepared.physicalRunRoot, AUTOMATIC_STUDY_ANALYSIS_DIRECTORY)).then(() => true,
        (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      return exists ? unknown() : undefined;
    }
    const bytes = await readBoundedStudyFile(root, JOB_FILE, MAX_JOB_BYTES);
    if (!bytes) return unknown();
    const record = parseJob(bytes, path.basename(prepared.physicalRunRoot));
    const view: AutomaticStudyAnalysisView = { state: record.state, analysisId: record.analysisId, reason: record.reason, updatedAt: record.updatedAt };
    const updated = Date.parse(record.updatedAt);
    if (updated > now || (pending(record.state) && now - updated > AUTOMATIC_STUDY_ANALYSIS_STALE_MS)) {
      return { ...view, state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" };
    }
    if (!await terminalResultMatches(prepared, record)) return { ...view, state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" };
    return view;
  } catch { return unknown(); }
}

async function terminalResultMatches(prepared: PreparedRunArtifactPaths, record: JobRecord): Promise<boolean> {
  if (pending(record.state) || record.state === "unknown" || record.state === "skipped") return true;
  if (record.analysisId === null) return record.state === "cancelled" || record.state === "failed";
  const matches = (value: { id: string; runId: string; sourceRunSha256: string; inputDigest: string; configDigest: string; promptVersion: string }): boolean =>
    value.id === record.analysisId && value.runId === record.runId && value.sourceRunSha256 === record.sourceRunSha256
    && value.inputDigest === record.inputDigest && value.configDigest === record.configDigest && value.promptVersion === record.promptVersion;
  const receipt = await readStudyAnalysisExecution(prepared, record.analysisId);
  if (!receipt || !matches(receipt) || hashStudyAnalysisValue(receipt) !== record.receiptSha256) return false;
  if (record.state === "failed" && record.reason === "AUTOMATIC_ANALYSIS_PUBLICATION_FAILED") return true;
  if (receipt.status !== record.state) return false;
  if (record.state === "failed" || record.state === "cancelled") return true;
  const entry = await readStudyAnalysisVersion(prepared, record.analysisId);
  return entry?.state === "ready" && entry.analysis !== null && matches(entry.analysis)
    && entry.analysis.status === record.state && hashStudyAnalysisValue(entry.analysis) === record.analysisSha256;
}

export interface AutomaticStudyAnalysisJob {
  readonly attemptId: string;
  /** Serialized, awaited durability boundary. A failed write must prevent dispatch. */
  update(update: Partial<Pick<JobRecord, "state" | "analysisId" | "reason" | "sourceRunSha256" | "inputDigest" | "startedAt" | "analysisSha256" | "receiptSha256">>): Promise<void>;
  touch(): Promise<void>;
  cancellationRequested(): Promise<boolean>;
}

/** The directory is permanent, including after interrupted/failed writes. Never re-open it as a writer. */
export async function claimAutomaticStudyAnalysis(prepared: PreparedRunArtifactPaths,
  metadata: { configDigest: string; promptVersion: string }): Promise<AutomaticStudyAnalysisJob | null> {
  await validatePreparedRunRootIdentity(prepared);
  const target = path.join(prepared.physicalRunRoot, AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; }
  const identity = await lstat(target, { bigint: true });
  const root = await prepareContainedOutputDirectoryRoot(prepared, AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
  if (root.identity.dev !== identity.dev || root.identity.ino !== identity.ino || root.identity.birthtimeNs !== identity.birthtimeNs) {
    throw new Error("AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE");
  }
  const createdAt = iso();
  let record: JobRecord = { schema: AUTOMATIC_STUDY_ANALYSIS_SCHEMA, runId: path.basename(prepared.physicalRunRoot),
    claimId: randomUUID(), attemptId: `analysis-${randomUUID()}`, state: "queued", analysisId: null, reason: null,
    createdAt, updatedAt: createdAt, ...metadata, sourceRunSha256: null, inputDigest: null, analysisSha256: null, receiptSha256: null,
    startedAt: null, finishedAt: null };
  let writes: Promise<void> = Promise.resolve();
  const write = async (next: JobRecord): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(next) + "\n");
    parseJob(bytes, record.runId);
    if (bytes.length > MAX_JOB_BYTES) throw new Error("AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE");
    await writeContainedOutputFile(root, JOB_FILE, bytes);
    record = next;
  };
  await write(record);
  const update: AutomaticStudyAnalysisJob["update"] = (change) => {
    writes = writes.then(async () => {
      if (!pending(record.state)) return;
      const now = iso();
      const state = change.state ?? record.state;
      await write({ ...record, ...change, state, updatedAt: now, finishedAt: pending(state) ? null : now });
    });
    return writes;
  };
  return {
    attemptId: record.attemptId, update, touch: () => update({}),
    async cancellationRequested() {
      await assertPreparedSelectedOutputDirectory(root);
      const bytes = await readBoundedStudyFile(root, CANCEL_FILE, 1024);
      if (!bytes) {
        const exists = await lstat(path.join(root.physicalPath, CANCEL_FILE)).then(() => true,
          (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
        if (exists) throw new Error("AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE");
        return false;
      }
      const cancel = cancelSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (cancel.runId !== record.runId || cancel.claimId !== record.claimId) throw new Error("AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE");
      return true;
    }
  };
}

/** A scoped cancellation request, never a PID signal and never permission to create a new job. */
export async function requestAutomaticStudyAnalysisCancellationPrepared(prepared: PreparedRunArtifactPaths): Promise<AutomaticStudyAnalysisCancellation> {
  try {
    const root = await bindJob(prepared);
    if (!root) return { requested: false, reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" };
    const bytes = await readBoundedStudyFile(root, JOB_FILE, MAX_JOB_BYTES);
    if (!bytes) throw new Error("Unavailable job.");
    const record = parseJob(bytes, path.basename(prepared.physicalRunRoot));
    if (!pending(record.state)) return { requested: false, reason: null };
    const cancellation = { schema: CANCEL_SCHEMA, runId: record.runId, claimId: record.claimId, requestedAt: iso() };
    await writeContainedOutputFile(root, CANCEL_FILE, JSON.stringify(cancellation) + "\n");
    return { requested: true, reason: null };
  } catch { return { requested: false, reason: "AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE" }; }
}
