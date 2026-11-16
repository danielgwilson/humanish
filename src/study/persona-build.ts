// Turn an export of real sessions into persona files: one file per drawn session, whose background
// states that session's measures, and the `participants:` block that assigns them. Pure: the
// `humanish personas build` command reads the files and writes the results.
import { createHash } from "node:crypto";
import { stringify } from "yaml";

import { isRecord } from "../run/type-guards.js";
import { personaTitleFromId } from "./persona-resolve.js";

/** The most sessions drawn when `--count` is not given. */
export const DEFAULT_PERSONA_COUNT = 50;
/** A study has at most 100 participants, so a build has at most 100 personas. */
export const MAX_PERSONA_COUNT = 100;
export const DEFAULT_PERSONA_SEED = 1;
export const DEFAULT_PERSONA_PREFIX = "visitor";

// prose-check: model prompt
const DEFAULT_INTRO =
  "How this person used this app on an earlier visit, which is how they use it now:";

export interface PersonaBuildInput {
  /** JSON Lines, or one JSON array, of flat session objects. */
  sessionsText: string;
  count?: number;
  seed?: number;
  /** Only these fields become measures. */
  measures?: readonly string[];
  prefix?: string;
}

export type MeasureKind = "number" | "yes/no";

/** Why a field in the export is not read into any persona. */
export type SkipReason =
  | "identifier or time"
  | "text"
  | "nested value"
  | "mixed types"
  | "not a finite number"
  | "no values"
  | "not named in --measures";

export type FieldReport =
  | { name: string; used: true; kind: MeasureKind }
  | { name: string; used: false; reason: SkipReason };

export type PersonaBuildErrorCode =
  | "HUMANISH_PERSONAS_INVALID_SESSIONS"
  | "HUMANISH_PERSONAS_INVALID_MEASURE"
  | "HUMANISH_PERSONAS_NO_MEASURES"
  | "HUMANISH_PERSONAS_INVALID_OPTION";

export interface PersonaBuildError {
  code: PersonaBuildErrorCode;
  message: string;
  /** The line of the sessions file that is not a session. */
  line?: number;
  /** The `--measures` field that cannot be a measure, and why. */
  field?: string;
  reason?: SkipReason | "not in the sessions file";
}

export type PersonaBuild =
  | {
      ok: true;
      /** Sessions in the export, and how many have at least one measure. */
      sessions: { read: number; usable: number };
      fields: FieldReport[];
      sampling: { drawn: number; seed: number; reused: boolean };
      files: Array<{ id: string; name: string; contents: string }>;
      /** A `participants:` block that gives each participant one built persona. */
      roster: string;
    }
  | { ok: false; error: PersonaBuildError; fields: FieldReport[] };

type Value = number | boolean;
type Session = ReadonlyMap<string, unknown>;

// The persona id grammar, `<prefix>-NNN`, within the 40 characters a participant id may have.
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PREFIX_MAX_CHARS = 36;

/** Build the personas, or say why not. The same input always gives the same files. */
export function buildPersonas(input: PersonaBuildInput): PersonaBuild {
  const fail = (error: PersonaBuildError, fields: FieldReport[] = []): PersonaBuild => ({
    ok: false,
    error,
    fields,
  });
  const option = optionError(input);
  if (option) return fail({ code: "HUMANISH_PERSONAS_INVALID_OPTION", message: option });
  const sessions = parseSessions(input.sessionsText);
  if (!Array.isArray(sessions))
    return fail({ code: "HUMANISH_PERSONAS_INVALID_SESSIONS", ...sessions });
  const fields = classifyFields(sessions);
  const narrowed = narrowFields(fields, input.measures);
  if ("code" in narrowed) return fail(narrowed, fields);
  const measures = narrowed.flatMap((field) => (field.used ? [field] : []));
  if (measures.length === 0)
    return fail(
      {
        code: "HUMANISH_PERSONAS_NO_MEASURES",
        message:
          "No field in the sessions file is a measure: a persona reads only fields whose values are all numbers or all true and false, and never one named like an identifier or a time. Add numeric or true/false columns to the export.",
      },
      narrowed,
    );
  const hasValue = (session: Session, name: string) =>
    session.get(name) !== null && session.get(name) !== undefined;
  const usable = sessions.filter((session) => measures.some(({ name }) => hasValue(session, name)));
  const count = input.count ?? Math.min(usable.length, DEFAULT_PERSONA_COUNT);
  const seed = input.seed ?? DEFAULT_PERSONA_SEED;
  const prefix = input.prefix ?? DEFAULT_PERSONA_PREFIX;
  const files = drawSessions(usable, count, seed).map((session, index) => {
    const number = index + 1;
    const id = `${prefix}-${String(number).padStart(3, "0")}`;
    const lines = measures.flatMap(({ name, kind }) =>
      hasValue(session, name) ? [measureLine(name, session.get(name) as Value, kind)] : [],
    );
    const persona = {
      schema: "humanish.persona.v1",
      id,
      name: `${personaTitleFromId(prefix)} ${number}`,
      background: [DEFAULT_INTRO, ...lines].join("\n"),
    };
    return { id, name: `${id}.yaml`, contents: stringify(persona, { lineWidth: 0 }) };
  });
  return {
    ok: true,
    sessions: { read: sessions.length, usable: usable.length },
    fields: narrowed,
    sampling: { drawn: files.length, seed, reused: count > usable.length },
    files,
    roster: rosterBlock(files.map((file) => file.id)),
  };
}

function optionError({ count, seed, prefix }: PersonaBuildInput): string | undefined {
  if (count !== undefined && !(Number.isInteger(count) && count >= 1 && count <= MAX_PERSONA_COUNT))
    return `--count must be a whole number from 1 to ${MAX_PERSONA_COUNT}, the most participants a study has.`;
  if (seed !== undefined && !(Number.isSafeInteger(seed) && seed >= 0))
    return "--seed must be a whole number, 0 or more.";
  if (prefix !== undefined && !(PREFIX_PATTERN.test(prefix) && prefix.length <= PREFIX_MAX_CHARS))
    return `--prefix must start with a letter or digit, hold only letters, digits, - and _, and be at most ${PREFIX_MAX_CHARS} characters, because it starts each persona id and file name.`;
  return undefined;
}

/** With `--measures`, only the named fields are measures; naming one that cannot be is an error. */
function narrowFields(
  fields: readonly FieldReport[],
  named: readonly string[] | undefined,
): FieldReport[] | PersonaBuildError {
  if (named === undefined) return [...fields];
  for (const name of named) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field === undefined)
      return {
        code: "HUMANISH_PERSONAS_INVALID_MEASURE",
        message: `--measures names ${name}, which no session in the sessions file has. Check the spelling against the export's column names.`,
        field: name,
        reason: "not in the sessions file",
      };
    if (!field.used)
      return {
        code: "HUMANISH_PERSONAS_INVALID_MEASURE",
        message: `--measures names ${name}, which cannot be a measure: ${SKIP_TEXT[field.reason]}. Leave it out of --measures.`,
        field: name,
        reason: field.reason,
      };
  }
  return fields.map((field) =>
    field.used && !named.includes(field.name)
      ? { name: field.name, used: false, reason: "not named in --measures" }
      : field,
  );
}

/** Why each skipped field is skipped, in words a person reads. */
export const SKIP_TEXT: Record<SkipReason, string> = {
  "identifier or time": "its name looks like an identifier or a time, which a persona never holds",
  text: "it holds text, which may be something a person typed",
  "nested value": "it holds a list or an object",
  "mixed types": "it mixes numbers and true/false values",
  "not a finite number": "one of its numbers is too large to read, such as 1e999",
  "no values": "every session has null or no value for it",
  "not named in --measures": "--measures does not name it",
};

/** The records of a JSON array, or of JSON Lines; the line or session that is not one otherwise. */
function parseSessions(text: string): Session[] | { message: string; line?: number } {
  const trimmed = text.trim();
  // Each record with the line it starts on, when the file is JSON Lines.
  const records: Array<{ record: unknown; line?: number }> = [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return { message: `The sessions file is not valid JSON: ${(error as Error).message}.` };
    }
    if (!Array.isArray(parsed)) return { message: "The sessions file is not a JSON array." };
    records.push(...parsed.map((record: unknown) => ({ record })));
  } else {
    for (const [index, json] of text.split(/\r?\n/).entries()) {
      if (!json.trim()) continue;
      const line = index + 1;
      try {
        records.push({ record: JSON.parse(json), line });
      } catch {
        return {
          message: `Line ${line} of the sessions file is not valid JSON. Each line holds one session as a JSON object.`,
          line,
        };
      }
    }
  }
  const sessions: Session[] = [];
  for (const [index, { record, line }] of records.entries()) {
    if (!isRecord(record) || Array.isArray(record))
      return {
        message: `${line === undefined ? `Session ${index + 1}` : `Line ${line}`} of the sessions file is not a JSON object. Each session is one object of field names and values.`,
        ...(line === undefined ? {} : { line }),
      };
    sessions.push(new Map(Object.entries(record)));
  }
  if (sessions.length === 0) return { message: "The sessions file holds no sessions." };
  return sessions;
}

/** Each field in order of first appearance, used as a measure or skipped with its reason. */
function classifyFields(sessions: readonly Session[]): FieldReport[] {
  const names = [...new Set(sessions.flatMap((session) => [...session.keys()]))];
  return names.map((name): FieldReport => {
    const skip = (reason: SkipReason): FieldReport => ({ name, used: false, reason });
    if (looksLikeIdentifierOrTime(name)) return skip("identifier or time");
    const values = sessions
      .map((session) => session.get(name))
      .filter((value) => value !== null && value !== undefined);
    if (values.length === 0) return skip("no values");
    if (values.some((value) => typeof value === "string")) return skip("text");
    if (values.some((value) => typeof value === "object")) return skip("nested value");
    if (values.every((value) => typeof value === "boolean"))
      return { name, used: true, kind: "yes/no" };
    if (!values.every((value) => typeof value === "number")) return skip("mixed types");
    if (!values.every((value) => Number.isFinite(value))) return skip("not a finite number");
    return { name, used: true, kind: "number" };
  });
}

// A word anywhere in the name that marks an identifier or a moment, such as `session_id`,
// `accountID`, `visit_date` or `eventTimestamp`. A measure's name rarely holds one.
const IDENTIFIER_WORDS = new Set(["id", "uuid", "guid", "email", "ip", "timestamp", "date"]);
// Whole names that hold an identifier, though as one word of a longer name (`session_count`,
// `user_rating`) they qualify a measure.
const IDENTIFIER_NAMES = new Set(["session", "user", "ts", "time", "datetime"]);

function looksLikeIdentifierOrTime(name: string): boolean {
  const words = fieldWords(name).split(" ");
  return (
    words.some((word) => IDENTIFIER_WORDS.has(word)) ||
    IDENTIFIER_NAMES.has(words.join("")) ||
    // `created_at`, `updatedAt`
    (words.length > 1 && words.at(-1) === "at")
  );
}

/** `rounds_played` and `roundsPlayed` both read `rounds played`; `accountID` reads `account id`. */
function fieldWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-\s.]+/g, " ")
    .trim()
    .toLowerCase();
}

/** A whole number, or one decimal below 10 when the value is not whole; halves round away from 0. */
function roundValue(value: number): number {
  if (Number.isInteger(value)) return value;
  const scale = Math.abs(value) < 10 ? 10 : 1;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** `- rounds played: about 3`; an exact 0 is not approximate, so it reads `0`. */
function measureLine(name: string, value: Value, kind: MeasureKind): string {
  if (kind === "yes/no") return `- ${fieldWords(name)}: ${value ? "yes" : "no"}`;
  const number = value as number;
  return `- ${fieldWords(name)}: ${number === 0 ? "0" : `about ${roundValue(number)}`}`;
}

/** Sessions ranked by a digest of the seed and their position, then the first `count`. */
function drawSessions(sessions: readonly Session[], count: number, seed: number): Session[] {
  const ranked = sessions
    .map((session, index) => ({
      session,
      key: createHash("sha256").update(`${seed}:${index}`).digest("hex"),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.session);
  return Array.from({ length: count }, (_, index) => ranked[index % ranked.length]!);
}

function rosterBlock(ids: readonly string[]): string {
  return stringify({ participants: ids.map((id) => ({ id, persona: id })) }, { lineWidth: 0 });
}
