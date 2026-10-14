// A run's raw sandbox ids live in one place: sandbox-receipts.ndjson, which reclaim reads to kill
// them and export omits. Every other record a run writes (run.json, its review and projections, the
// cleanup and reclaim receipts) and every result or CLI line names a sandbox by marker and digest,
// so output an agent pastes into an issue never carries an id.

import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

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

/**
 * Whether a text holds any of `ids`, in one RegExp scan, since nearly every token of a trace holds
 * none: on 25 participants' 750 MiB of trace text, one scan for each id took 6.6 of 7.8 seconds.
 */
function anyIdTest(ids: readonly string[]): (text: string) => boolean {
  const eachId = (text: string): boolean => ids.some((id) => text.includes(id));
  let pattern: RegExp | undefined = new RegExp(ids.map(escapeRegExp).join("|"));
  return (text) => {
    if (pattern !== undefined) {
      try {
        return pattern.test(text);
      } catch {
        // V8 compiles the pattern on its first use, and refuses one of 40,000 characters or so.
        // Its error quotes the pattern and so the ids, and a scan for each id finds the same.
        pattern = undefined;
      }
    }
    return eachId(text);
  };
}

/** The scrub of one text: every occurrence of each raw id replaced by its label, longest id first. */
function idScrub(ids: Iterable<string>, label: (id: string) => string): (text: string) => string {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  unique.sort((left, right) => right.length - left.length);
  const labels = unique.map((id): [string, string] => [id, label(id)]);
  // A text with no id gets no label, so skipping it changes nothing.
  const holdsId = anyIdTest(unique);
  return (text) =>
    labels.length === 0 || !holdsId(text)
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

/** JSON.isRawJSON, which the ES2023 types leave out. */
const isRawJSON = (JSON as unknown as { isRawJSON: (value: unknown) => boolean }).isRawJSON;

/**
 * What JSON.stringify serializes for `raw` at `key`: what its toJSON returns, and a boxed
 * primitive's value. The steps follow SerializeJSONProperty, so a value converts as it did there.
 */
function jsonValue(key: string | number, raw: unknown): unknown {
  // JSON.stringify asks only an object, a function or a bigint for toJSON.
  if (
    raw === null ||
    (typeof raw !== "object" && typeof raw !== "function" && typeof raw !== "bigint")
  )
    return raw;
  const toJSON: unknown = (raw as { toJSON?: unknown }).toJSON;
  const json: unknown = typeof toJSON === "function" ? toJSON.call(raw, String(key)) : raw;
  if (json === null || typeof json !== "object") return json;
  // These find the boxed value in any realm, and read it as JSON.stringify does.
  if (types.isNumberObject(json)) return Number(json);
  if (types.isStringObject(json)) return String(json);
  if (types.isBooleanObject(json)) return Boolean.prototype.valueOf.call(json);
  if (types.isBigIntObject(json)) return BigInt.prototype.valueOf.call(json);
  return json;
}

/**
 * The characters that let an id reach past one token of a JSON text: the punctuation between
 * tokens, and the quote and backslash that decide where a string ends.
 */
const CROSSES_TOKENS = /[{}[\],:"\\]/;

/**
 * JSON.parse(scrub(JSON.stringify(value))), built one JSON token at a time: each string, key,
 * number, boolean and null is serialized, scrubbed and parsed on its own, following the rules
 * JSON.stringify applies (toJSON, boxed primitives, members it omits). A run bundle holds every
 * finished trace, and its whole text can pass V8's longest string. For ids that hold none of
 * CROSSES_TOKENS, every occurrence lies inside one token of the whole text, and the labels add
 * no quote or backslash. Each scrubbed token then parses on its own exactly when the whole text
 * parses, so this returns what the whole text parsed to and throws where its parse threw.
 * `changed` says whether the scrub rewrote any token.
 */
function scrubTokens(value: unknown, ids: readonly string[]): { value: unknown; changed: boolean } {
  const scrub = idScrub(ids, sandboxIdLabel);
  let changed = false;
  // What JSON.parse reads from one token's text once its ids are labeled. `asWritten` gives what
  // it reads from the text unchanged, which saves a parse on nearly every token.
  const token = (text: string, asWritten: () => unknown): unknown => {
    const scrubbed = scrub(text);
    if (scrubbed === text) return asWritten();
    changed = true;
    // A label that breaks an escape or lands outside a string throws, as the whole text did.
    return JSON.parse(scrubbed);
  };
  // Keys repeat across a trace's items, so each key that holds no id is scrubbed once.
  const cleanKeys = new Set<string>();
  const scrubKey = (name: string): string => {
    if (cleanKeys.has(name)) return name;
    const text = JSON.stringify(name);
    const scrubbed = scrub(text);
    if (scrubbed === text) {
      cleanKeys.add(name);
      return name;
    }
    changed = true;
    return JSON.parse(scrubbed) as string;
  };
  // The text of a finite number reads back as the same number, apart from -0, which reads as 0.
  const readNumber = (number: number): number | null =>
    Number.isFinite(number) ? (number === 0 ? 0 : number) : null;
  const property = (key: string | number, raw: unknown): unknown => {
    const json = jsonValue(key, raw);
    if (typeof json === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
    if (json === null) return token("null", () => null);
    if (typeof json === "boolean") return token(String(json), () => json);
    if (typeof json === "number") return token(JSON.stringify(json), () => readNumber(json));
    if (typeof json === "string") return token(JSON.stringify(json), () => json);
    // Left: undefined, a symbol, a function.
    if (typeof json !== "object") return OMITTED;
    if (isRawJSON(json)) {
      const text = (json as { rawJSON: string }).rawJSON;
      return token(text, () => JSON.parse(text) as unknown);
    }
    if (Array.isArray(json)) {
      const items: unknown[] = [];
      // JSON.stringify reads the length once, before any element.
      const length = json.length;
      for (let index = 0; index < length; index += 1) {
        const item = property(index, json[index]);
        // The whole text holds `null` there, which an id can occur in.
        items.push(item === OMITTED ? token("null", () => null) : item);
      }
      return items;
    }
    // Built by assignment, which took 1.8 seconds where Object.fromEntries took 2.0 on 100 MiB of
    // trace items. A key that two members scrub to holds the last value at the first position,
    // as JSON.parse does.
    const members: Record<string, unknown> = {};
    for (const name of Object.keys(json)) {
      const item = property(name, (json as Record<string, unknown>)[name]);
      if (item === OMITTED) continue;
      const member = scrubKey(name);
      // Assigning __proto__ would set the prototype; JSON.parse makes it an own property.
      if (member === "__proto__")
        Object.defineProperty(members, member, {
          value: item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      else members[member] = item;
    }
    return members;
  };
  const scrubbed = property("", value);
  return { value: scrubbed, changed };
}

/**
 * `value` as it may be written or returned: ids at the sandbox-id keys become the marker and a
 * digest, and any raw id left in free text, a key or a URL becomes its label. When a label
 * replaces anything, the result is what JSON.parse returns for the scrubbed JSON text; otherwise
 * it is the key-redacted value. With ids shaped like E2B's, no string built holds more than one
 * token of that text, so a run bundle's traces are never joined in one string.
 */
export function publicSandboxView<T>(value: T, ids: Iterable<string>): T {
  const redacted = redactSandboxIds(value);
  const known = [...ids];
  if (known.length === 0) return redacted as T;
  if (known.some((id) => CROSSES_TOKENS.test(id))) {
    // Such an id can span two tokens or move where a string ends, which only the whole text
    // shows. No E2B id holds one; a bundle past V8's longest string throws here.
    const text = JSON.stringify(redacted);
    if (text === undefined) return redacted as T;
    const scrubbed = scrubSandboxIds(text, known);
    return (scrubbed === text ? redacted : JSON.parse(scrubbed)) as T;
  }
  const scrubbed = scrubTokens(redacted, known);
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
