// A run's raw sandbox ids live in one place: sandbox-receipts.ndjson, which reclaim reads to kill
// them and export omits. Every other record a run writes (run.json, its review and projections, the
// cleanup and reclaim receipts) and every result or CLI line names a sandbox by marker and digest,
// so output an agent pastes into an issue never carries an id.

import { redactSandboxIds, sandboxIdDigest, REDACTED_SANDBOX_ID } from "../evidence/redaction.js";
import { readContainedRegularFile, type PreparedOutputRoot } from "./contained-output.js";
import { bindExistingRunArtifactPaths, isSafeRunIdSegment } from "./paths.js";
import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";

/** How text names a sandbox: the marker with the id's digest. */
function sandboxIdLabel(id: string): string {
  return `${REDACTED_SANDBOX_ID.slice(0, -1)} ${sandboxIdDigest(id)}]`;
}

/** `text` with every occurrence of each raw id replaced by its label, longest id first. */
export function scrubSandboxIds(text: string, ids: Iterable<string>): string {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  unique.sort((left, right) => right.length - left.length);
  return unique.reduce((current, id) => current.split(id).join(sandboxIdLabel(id)), text);
}

/**
 * `value` as it may be written or returned: ids at the sandbox-id keys become the marker and a
 * digest, and any raw id left in free text or a URL becomes its label.
 */
export function publicSandboxView<T>(value: T, ids: Iterable<string>): T {
  const redacted = redactSandboxIds(value);
  const known = [...ids];
  if (known.length === 0) return redacted as T;
  const text = JSON.stringify(redacted);
  if (text === undefined) return redacted as T;
  const scrubbed = scrubSandboxIds(text, known);
  return (scrubbed === text ? redacted : JSON.parse(scrubbed)) as T;
}

/** The raw sandbox ids a receipts journal names. */
function receiptSandboxIds(journal: Buffer | string): string[] {
  return parseSandboxReceipts(journal.toString()).map((receipt) => receipt.sandboxId);
}

/** The raw sandbox ids in the receipts among a run's files, read as bytes by path. */
export function inventorySandboxIds(files: readonly { path: string; bytes: Buffer }[]): string[] {
  const journal = files.find((file) => file.path === SANDBOX_RECEIPTS_ARTIFACT);
  return journal === undefined ? [] : receiptSandboxIds(journal.bytes);
}

/** The raw sandbox ids a run's receipts journal; empty when it has none or they cannot be read. */
export async function readRunSandboxIds(root: PreparedOutputRoot): Promise<string[]> {
  try {
    const bytes = await readContainedRegularFile(root, SANDBOX_RECEIPTS_ARTIFACT);
    return bytes ? receiptSandboxIds(bytes) : [];
  } catch {
    return [];
  }
}

/**
 * `value` as a run writes it: raw sandbox ids stay in the run's sandbox-receipts.ndjson, and the
 * file names each by marker and digest.
 */
export async function withPublicSandboxIds<T>(root: PreparedOutputRoot, value: T): Promise<T> {
  return publicSandboxView(value, await readRunSandboxIds(root));
}

/** `bytes` with each raw id replaced by its label: the same buffer when none occurs. */
export function scrubSandboxIdBytes(bytes: Buffer, ids: readonly string[]): Buffer {
  if (ids.length === 0) return bytes;
  const text = bytes.toString("utf8");
  const scrubbed = scrubSandboxIds(text, ids);
  return scrubbed === text ? bytes : Buffer.from(scrubbed);
}

/**
 * A run's result as it may be returned or printed: the same object when it names no sandbox,
 * otherwise its public view, scrubbed of the ids the run's receipts journal.
 */
export async function publicRunResult<T extends { runId?: string }>(
  result: T,
  cwd: string,
): Promise<T> {
  let ids: string[] = [];
  if (typeof result.runId === "string" && isSafeRunIdSegment(result.runId)) {
    try {
      ids = await readRunSandboxIds(await bindExistingRunArtifactPaths(cwd, result.runId));
    } catch {
      // A run that never created its directory has no receipts; the keys are still redacted.
    }
  }
  return publicSandboxView(result, ids);
}
