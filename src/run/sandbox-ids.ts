// A run's raw sandbox ids live in one place: sandbox-receipts.ndjson, which reclaim reads to kill
// them and export omits. Every other record a run writes (run.json, its review and projections, the
// cleanup and reclaim receipts) and every result or CLI line names a sandbox by marker and digest,
// so output an agent pastes into an issue never carries an id.

import { opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { readPlainText } from "../evidence/plain-text.js";
import {
  collectSandboxIds,
  redactSandboxIds,
  sandboxIdDigest,
  REDACTED_SANDBOX_ID,
} from "../evidence/redaction.js";
import {
  ContainedReadRefusedError,
  readContainedRegularFile,
  refusalText,
  RUN_ARTIFACT_MAX_BYTES,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "./contained-output.js";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  validatePreparedRunRootIdentity,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  appendedSandboxIds,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "./sandbox-receipts.js";
import { escapeRegExp } from "./text.js";

/** How text names a sandbox: the marker with the id's digest. */
function sandboxIdLabel(id: string): string {
  return `${REDACTED_SANDBOX_ID.slice(0, -1)} ${sandboxIdDigest(id)}]`;
}

/**
 * How YAML names a sandbox: the label without its brackets, since a plain scalar that starts with
 * `[` reads as a list. Every other byte of the file stays as written.
 */
function yamlSandboxIdLabel(id: string): string {
  return `redacted-sandbox-id-${sandboxIdDigest(id)}`;
}

/** The scrub of one text: every occurrence of each raw id replaced by its label, longest id first. */
function idScrub(ids: Iterable<string>, label: (id: string) => string): (text: string) => string {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  unique.sort((left, right) => right.length - left.length);
  const labels = unique.map((id): [string, string] => [id, label(id)]);
  // One scan for any id first, since nearly every token of a trace holds none: on 25 participants'
  // 750 MiB of trace text, one scan for each id took 6.6 of 7.8 seconds. A text with no id gets
  // no label, so skipping it changes nothing.
  const anyId = new RegExp(unique.map(escapeRegExp).join("|"));
  return (text) =>
    labels.length === 0 || !anyId.test(text)
      ? text
      : labels.reduce((current, [id, replacement]) => current.split(id).join(replacement), text);
}

/** `text` with every occurrence of each raw id replaced by its label, longest id first. */
export function scrubSandboxIds(
  text: string,
  ids: Iterable<string>,
  label: (id: string) => string = sandboxIdLabel,
): string {
  return idScrub(ids, label)(text);
}

/** A value JSON.stringify leaves out: an object drops the property, an array writes null. */
const OMITTED = Symbol("omitted");

/**
 * JSON.parse(scrub(JSON.stringify(value))), built one JSON token at a time: each string, key,
 * number, boolean and null is serialized, scrubbed and parsed on its own, following the rules
 * JSON.stringify applies (toJSON, boxed primitives, members it omits). A run bundle holds every
 * finished trace, and its whole text can pass V8's longest string. A raw id that holds none of
 * `{}[],:` lies inside one token of the whole text, so the result is the same. An id holding one
 * of them could span two tokens there, and this leaves such a span: the sweep at Run.finish
 * scrubs each written file's whole text, and verify grades a file that still names an id.
 * `changed` says whether the scrub rewrote any token.
 */
function scrubTokens(
  value: unknown,
  scrub: (text: string) => string,
): { value: unknown; changed: boolean } {
  let changed = false;
  const token = (primitive: unknown): unknown => {
    // A bigint throws here, as it did in the whole text's JSON.stringify.
    const text = JSON.stringify(primitive);
    const scrubbed = scrub(text);
    if (scrubbed !== text) changed = true;
    // An unchanged string parses back to itself. A number parses, so -0 and Infinity read as
    // JSON.parse reads them. A label that breaks an escape or a quote throws, as before.
    return typeof primitive === "string" && scrubbed === text ? primitive : JSON.parse(scrubbed);
  };
  const property = (key: string, raw: unknown): unknown => {
    let json = raw;
    if (json !== null && typeof json === "object" && "toJSON" in json) {
      const toJSON: unknown = json.toJSON;
      if (typeof toJSON === "function") json = toJSON.call(json, key) as unknown;
    }
    if (json instanceof Number || json instanceof String || json instanceof Boolean)
      json = json.valueOf();
    if (json === undefined || typeof json === "function" || typeof json === "symbol")
      return OMITTED;
    if (json === null || typeof json !== "object") return token(json);
    if (Array.isArray(json)) {
      const items: unknown[] = [];
      for (let index = 0; index < json.length; index += 1) {
        const item = property(String(index), json[index]);
        // The whole text holds `null` there, which an id can occur in.
        items.push(item === OMITTED ? token(null) : item);
      }
      return items;
    }
    const entries: [string, unknown][] = [];
    for (const name of Object.keys(json)) {
      const item = property(name, (json as Record<string, unknown>)[name]);
      if (item !== OMITTED) entries.push([token(name) as string, item]);
    }
    // fromEntries keeps a key such as __proto__ an own property, and a key that two members
    // scrub to holds the last value at the first position, as JSON.parse does.
    return Object.fromEntries(entries);
  };
  const scrubbed = property("", value);
  return { value: scrubbed, changed };
}

/**
 * `value` as it may be written or returned: ids at the sandbox-id keys become the marker and a
 * digest, and any raw id left in free text, a key or a URL becomes its label. When a label
 * replaces anything, the result is what JSON.parse returns for the scrubbed JSON text; otherwise
 * it is the key-redacted value. No string built holds more than one token of that text, so a run
 * bundle's traces are never joined in one string.
 */
export function publicSandboxView<T>(value: T, ids: Iterable<string>): T {
  const redacted = redactSandboxIds(value);
  const known = [...ids];
  if (known.length === 0) return redacted as T;
  const scrubbed = scrubTokens(redacted, idScrub(known, sandboxIdLabel));
  return (scrubbed.changed ? scrubbed.value : redacted) as T;
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
  // Most run files name no sandbox key, and parsing each one would slow verify on large runs. A
  // key spelled with an escape only shows once parsed.
  if (!/"(?:sandboxId|subjectSandboxId|providerResources|resources)"|\\u/.test(text)) return [];
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

/** Whether a run file's JSON holds a raw id at a sandbox-id key, which no receipt may name. */
export function holdsKeyedSandboxId(file: string, text: string): boolean {
  return jsonRecords(file, text).some((record) => collectSandboxIds(record).size > 0);
}

/**
 * The raw sandbox ids a run's receipts journal, with any this process receipted whose append
 * failed; none from the journal when it is missing or malformed, or when a folder is where it goes
 * (a failed append can leave one, and the process still holds those ids). A journal refused for
 * any other reason, a link or one too large to read say, throws ContainedReadRefusedError: every
 * caller would otherwise write or grade a run's files without the ids it may hold.
 */
export async function readRunSandboxIds(root: PreparedOutputRoot): Promise<string[]> {
  const read = await readContainedRegularFile(
    root,
    SANDBOX_RECEIPTS_ARTIFACT,
    RUN_ARTIFACT_MAX_BYTES,
  );
  if (read.status === "refused" && read.reason !== "directory")
    throw new ContainedReadRefusedError(SANDBOX_RECEIPTS_ARTIFACT, read);
  let journaled: string[] = [];
  try {
    if (read.status === "read") journaled = receiptSandboxIds(read.bytes);
  } catch {
    // The ids this process receipted still apply.
  }
  return [...new Set([...journaled, ...appendedSandboxIds(root)])];
}

/**
 * The bytes of `file` with each raw id replaced by its label: the same buffer when none occurs, or
 * when the bytes are not the plain text verify and export read as text.
 */
export function scrubSandboxIdBytes(file: string, bytes: Buffer, ids: readonly string[]): Buffer {
  if (!ids.some((id) => id.length > 0 && bytes.includes(id))) return bytes;
  const decoded = readPlainText(bytes);
  if (!decoded.ok) return bytes;
  const label = /\.ya?ml$/i.test(file) ? yamlSandboxIdLabel : sandboxIdLabel;
  return Buffer.from(scrubSandboxIds(decoded.text, ids, label));
}

/** The run files the sweep rewrites: the text formats export copies, and the Observer page. */
const TEXT_FILE = /\.(?:json|ndjson|jsonl|md|txt|log|yaml|yml|csv|html)$/i;

/** Enough for any run directory; a sweep stops there rather than hold up the run's finish. */
const MAX_SWEPT_ENTRIES = 10_000;

/**
 * Rewrite each file of a finished run that names one of its raw sandbox ids, apart from the
 * receipts, with the label in place of the id. Writers such as a participant's actor.json can
 * quote an SDK error that names the sandbox. Run.finish calls it before analysis reads the run.
 * Best effort for writes and listings: verify grades a file this misses. A text file it refuses
 * to read, or a journal it refuses, throws once the sweep ends, naming each, since such a file
 * may still hold an id.
 */
export async function scrubRunSandboxIds(paths: PreparedRunArtifactPaths): Promise<void> {
  const ids = await readRunSandboxIds(paths);
  if (ids.length === 0) return;
  const valid = await validatePreparedRunRootIdentity(paths).then(
    () => true,
    () => false,
  );
  if (!valid) return;
  const refused: string[] = [];
  const scrub = async (file: string): Promise<void> => {
    const read = await readContainedRegularFile(paths, file, RUN_ARTIFACT_MAX_BYTES);
    if (read.status === "refused") refused.push(refusalText(file, read));
    if (read.status !== "read") return;
    const scrubbed = scrubSandboxIdBytes(file, read.bytes, ids);
    if (scrubbed !== read.bytes) await writeContainedOutputFile(paths, file, scrubbed);
  };
  let seen = 0;
  const walk = async (relative: string): Promise<void> => {
    const directory = path.join(paths.physicalRunRoot, relative);
    // A directory replaced by a link after it was listed resolves elsewhere and is not walked.
    if ((await realpath(directory).catch(() => null)) !== directory) return;
    const listing = await opendir(directory).catch(() => null);
    if (listing === null) return;
    for await (const entry of listing) {
      // Returning from the loop closes the listing.
      if (++seen > MAX_SWEPT_ENTRIES) return;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file !== SANDBOX_RECEIPTS_ARTIFACT && TEXT_FILE.test(file))
        // A file that cannot be scrubbed stays as written; verify names it.
        await scrub(file).catch(() => {});
    }
  };
  await walk("").catch(() => {
    // A directory that changed while it was listed ends the sweep; verify names what it missed.
  });
  if (refused.length > 0)
    throw new Error(
      `The sandbox id sweep could not read every run file, so these may still name a sandbox: ${refused.join("; ")}.`,
    );
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
    let paths: PreparedRunArtifactPaths | undefined;
    try {
      paths = await bindExistingRunArtifactPaths(cwd, result.runId);
    } catch {
      // A run that never created its directory has no receipts; the keys are still redacted.
    }
    // A journal that is there and refused throws: the result cannot be printed without its ids.
    if (paths !== undefined) ids = await readRunSandboxIds(paths);
  }
  return publicSandboxView(result, ids);
}
