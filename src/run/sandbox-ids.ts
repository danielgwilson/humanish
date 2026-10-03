// A run's raw sandbox ids live in one place: sandbox-receipts.ndjson, which reclaim reads to kill
// them and export omits. Every other record a run writes (run.json, its review and projections, the
// cleanup and reclaim receipts) and every result or CLI line names a sandbox by marker and digest,
// so output an agent pastes into an issue never carries an id.

import { readdir } from "node:fs/promises";
import path from "node:path";

import { Scalar, parseDocument, visit } from "yaml";

import {
  collectSandboxIds,
  redactSandboxIds,
  sandboxIdDigest,
  REDACTED_SANDBOX_ID,
} from "../evidence/redaction.js";
import {
  readContainedRegularFile,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "./contained-output.js";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  appendedSandboxIds,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "./sandbox-receipts.js";

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
 * YAML `text` scrubbed with each value keeping its type: a plain scalar that would start with the
 * label's `[` would read as a list, so a changed scalar is written double-quoted.
 */
function scrubYamlSandboxIds(text: string, ids: readonly string[]): string {
  const document = parseDocument(text, { logLevel: "silent" });
  if (document.errors.length > 0) return scrubSandboxIds(text, ids);
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value !== "string") return;
      const scrubbed = scrubSandboxIds(node.value, ids);
      if (scrubbed === node.value) return;
      node.value = scrubbed;
      node.type = Scalar.QUOTE_DOUBLE;
    },
  });
  // Comments are not values; the plain scrub covers an id named in one.
  return scrubSandboxIds(document.toString(), ids);
}

/** The text of `file` scrubbed of `ids`, by its format. */
function scrubSandboxIdText(file: string, text: string, ids: readonly string[]): string {
  if (!ids.some((id) => id.length > 0 && text.includes(id))) return text;
  return /\.ya?ml$/i.test(file) ? scrubYamlSandboxIds(text, ids) : scrubSandboxIds(text, ids);
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

/**
 * The raw ids at sandbox-id keys in `value`, such as a run.json recorded before 0.110. A value
 * shorter than an E2B id is left to the key rule, so the text scrub never rewrites a common word.
 */
export function keyedSandboxIds(value: unknown): string[] {
  return [...collectSandboxIds(value)].filter((id) => id.length >= 8);
}

/** The JSON records in one file's text: one document, or one per NDJSON line. */
function jsonRecords(file: string, text: string): unknown[] {
  const parse = (part: string): unknown[] => {
    try {
      return [JSON.parse(part)];
    } catch {
      return [];
    }
  };
  if (/\.json$/i.test(file)) return parse(text);
  if (/\.(?:ndjson|jsonl)$/i.test(file)) return text.split("\n").flatMap(parse);
  return [];
}

/**
 * Every raw sandbox id a run's files name: the receipts', and any at a sandbox-id key in its
 * JSON, which is where a run from before 0.110 that has no receipts still records them.
 */
export function inventorySandboxIds(files: readonly { path: string; bytes: Buffer }[]): string[] {
  const ids = new Set<string>();
  for (const file of files) {
    if (file.path === SANDBOX_RECEIPTS_ARTIFACT) {
      for (const id of receiptSandboxIds(file.bytes)) ids.add(id);
      continue;
    }
    for (const record of jsonRecords(file.path, file.bytes.toString("utf8")))
      for (const id of keyedSandboxIds(record)) ids.add(id);
  }
  return [...ids];
}

/**
 * The raw sandbox ids a run's receipts journal, with any this process receipted whose append
 * failed; empty when there are none or the journal cannot be read.
 */
export async function readRunSandboxIds(root: PreparedOutputRoot): Promise<string[]> {
  let journaled: string[] = [];
  try {
    const bytes = await readContainedRegularFile(root, SANDBOX_RECEIPTS_ARTIFACT);
    if (bytes) journaled = receiptSandboxIds(bytes);
  } catch {
    // The ids this process receipted still apply.
  }
  return [...new Set([...journaled, ...appendedSandboxIds(root)])];
}

/**
 * `value` as a run writes it: raw sandbox ids stay in the run's sandbox-receipts.ndjson, and the
 * file names each by marker and digest.
 */
export async function withPublicSandboxIds<T>(root: PreparedOutputRoot, value: T): Promise<T> {
  return publicSandboxView(value, await readRunSandboxIds(root));
}

/**
 * The bytes of `file` with each raw id replaced by its label: the same buffer when none occurs, or
 * when the bytes are not UTF-8 text a replacement could keep intact.
 */
export function scrubSandboxIdBytes(file: string, bytes: Buffer, ids: readonly string[]): Buffer {
  if (!ids.some((id) => id.length > 0 && bytes.includes(id))) return bytes;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return bytes;
  const scrubbed = scrubSandboxIdText(file, text, ids);
  return scrubbed === text ? bytes : Buffer.from(scrubbed);
}

/** Media a run records: never text, and too large to read for a scrub. */
const MEDIA = /\.(?:png|jpe?g|webp|gif|mp4|webm)$/i;

/**
 * Rewrite each file of a finished run that names one of its raw sandbox ids, apart from the
 * receipts, with the label in place of the id. Writers such as a participant's actor.json can
 * quote an SDK error that names the sandbox. Run.finish calls it before analysis reads the run.
 * Best effort: verify grades a file this misses.
 */
export async function scrubRunSandboxIds(paths: PreparedRunArtifactPaths): Promise<void> {
  const ids = await readRunSandboxIds(paths);
  if (ids.length === 0) return;
  const scrub = async (file: string): Promise<void> => {
    const bytes = await readContainedRegularFile(paths, file);
    if (bytes === null) return;
    const scrubbed = scrubSandboxIdBytes(file, bytes, ids);
    if (scrubbed !== bytes) await writeContainedOutputFile(paths, file, scrubbed);
  };
  const walk = async (relative: string): Promise<void> => {
    const directory = path.join(paths.physicalRunRoot, relative);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file !== SANDBOX_RECEIPTS_ARTIFACT && !MEDIA.test(file))
        // A file that cannot be scrubbed stays as written; verify names it.
        await scrub(file).catch(() => {});
    }
  };
  await walk("");
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
