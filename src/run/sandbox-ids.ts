// A run's raw sandbox ids live in one place: sandbox-receipts.ndjson, which reclaim reads to kill
// them and export omits. Every other record a run writes (run.json, its review and projections, the
// cleanup and reclaim receipts) and every result or CLI line names a sandbox by marker and digest,
// so output an agent pastes into an issue never carries an id.

import { opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { splitAtArray, type ArraySplit } from "../evidence/json-split.js";
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

/** `text` with every occurrence of each raw id replaced by its label, longest id first. */
export function scrubSandboxIds(
  text: string,
  ids: Iterable<string>,
  label: (id: string) => string = sandboxIdLabel,
): string {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  unique.sort((left, right) => right.length - left.length);
  return unique.reduce((current, id) => current.split(id).join(label(id)), text);
}

// A run bundle holds every finished participant's trace, and its whole JSON text can pass V8's
// longest string, 536,870,888 characters on Node 24. publicSandboxView scrubs such a bundle in
// pieces: the shell, which is the bundle's JSON text with `streams` written as `[]`, and the JSON
// text of each stream on its own. The pieces give what the whole text gives:
// - An id that holds none of {}[],:"\ lies inside one token of the whole text. Each cut between
//   pieces falls between two of the characters {}[], and the placeholder adds only [ and ], so no
//   occurrence crosses a cut. A replacement leaves those characters in place, so the next id's
//   occurrences cannot cross one either.
// - A label holds no quote or backslash, so it never moves the end of a string. A label inside an
//   escape, a number, true, false or null makes its piece fail to parse, and the whole text fails
//   the same way.
// - JSON.stringify writes a stream's members alone as it writes them inside the bundle, since each
//   gets the same key for its toJSON. Only the stream itself would get "" in place of its index,
//   and splitAtArray takes no stream with a toJSON. The members before `streams`, each stream and
//   the members after are serialized in that order, which is the order the whole text runs each
//   toJSON in.
// - The parsed shell keeps its keys in the order JSON.parse gives for the whole text, and the
//   streams go in at the place of `streams`. A key a label went into holds the label's `[`, so no
//   other key becomes `streams`. An id inside the key `streams` itself takes the whole text.
// - Once a label goes in, the view is parsed from the scrubbed pieces, as it was from the whole
//   text. A piece kept as given could run a toJSON or getter again when the view is written.
// - All of this holds for a bundle that serializing leaves unchanged, as every bundle JSON.parse
//   returns is. splitAtArray reads the streams before any toJSON runs.

/** The characters that let an id reach past one token of a JSON text or move where a string ends. */
const CROSSES_TOKENS = /[{}[\],:"\\]/;

/** Whether every occurrence of `id` in a bundle's JSON text stays inside one piece. */
const staysInOnePiece = (id: string): boolean =>
  id.length === 0 || (!CROSSES_TOKENS.test(id) && !"streams".includes(id));

/**
 * `value` as it may be written or returned: ids at the sandbox-id keys become the marker and a
 * digest, and any raw id left in free text, a key or a URL becomes its label. When no label goes
 * in, the result is the key-redacted value. Otherwise it is what JSON.parse returns for the
 * scrubbed JSON text of that value. A run bundle is scrubbed one stream at a time, so no string
 * holds two streams unless a member outside `streams` holds them too. An id that holds one of
 * {}[],:"\ makes the scrub work on the whole text, which throws RangeError for a bundle past V8's
 * longest string. No E2B id holds one.
 */
export function publicSandboxView<T>(value: T, ids: Iterable<string>): T {
  const redacted = redactSandboxIds(value);
  const known = [...ids];
  if (known.length === 0) return redacted as T;
  const split = known.every(staysInOnePiece) ? splitAtArray(redacted, "streams") : undefined;
  return (
    split === undefined ? wholeTextView(redacted, known) : streamwiseView(redacted, split, known)
  ) as T;
}

/** The scrub of `value`'s whole JSON text, parsed back when a label went in. */
function wholeTextView(value: unknown, ids: readonly string[]): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) return value;
  const scrubbed = scrubSandboxIds(text, ids);
  return scrubbed === text ? value : JSON.parse(scrubbed);
}

/** The bundle's whole-text scrub, built from its shell and each stream scrubbed on its own. */
function streamwiseView(bundle: unknown, split: ArraySplit, ids: readonly string[]): unknown {
  const before = split.before();
  let changed = false;
  // Each stream is parsed at its turn, even before any label goes in, since a later piece can still
  // take one and by then the earlier streams' text is gone.
  const streams = split.elements.map((stream) => {
    const text = JSON.stringify(stream);
    const scrubbed = scrubSandboxIds(text, ids);
    if (scrubbed !== text) changed = true;
    return JSON.parse(scrubbed) as unknown;
  });
  const shellText = before + split.after();
  const shell = scrubSandboxIds(shellText, ids);
  if (!changed && shell === shellText) return bundle;
  // Assigning to `streams` keeps its place among the keys.
  const view = JSON.parse(shell) as Record<string, unknown>;
  view.streams = streams;
  return view;
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
