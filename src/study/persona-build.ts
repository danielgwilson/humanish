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
  | { ok: false; error: { code: PersonaBuildErrorCode; message: string }; fields: FieldReport[] };

type Value = number | boolean;
type Session = ReadonlyMap<string, unknown>;

/** Build the personas, or say why not. The same input always gives the same files. */
export function buildPersonas(input: PersonaBuildInput): PersonaBuild {
  const fail = (code: PersonaBuildErrorCode, message: string, fields: FieldReport[] = []) =>
    ({ ok: false, error: { code, message }, fields }) as const;
  const sessions = parseSessions(input.sessionsText);
  if (typeof sessions === "string") return fail("HUMANISH_PERSONAS_INVALID_SESSIONS", sessions);
  const prefix = input.prefix ?? DEFAULT_PERSONA_PREFIX;
  const fields = classifyFields(sessions);
  const measures = fields.filter((field) => field.used).map((field) => field.name);
  if (measures.length === 0)
    return fail(
      "HUMANISH_PERSONAS_NO_MEASURES",
      "No field in the sessions file is a measure: a persona reads only fields whose values are all numbers or all true and false, and never one named like an identifier or a time. Add numeric or true/false columns to the export.",
      fields,
    );
  const usable = sessions.filter((session) =>
    measures.some((name) => session.get(name) !== null && session.get(name) !== undefined),
  );
  const count = Math.min(usable.length, DEFAULT_PERSONA_COUNT);
  const seed = input.seed ?? DEFAULT_PERSONA_SEED;
  const drawn = drawSessions(usable, count, seed);
  const kinds = new Map(
    fields.flatMap((field) => (field.used ? [[field.name, field.kind] as const] : [])),
  );
  const files = drawn.map((session, index) => {
    const number = index + 1;
    const id = `${prefix}-${String(number).padStart(3, "0")}`;
    const lines = measures.flatMap((name) => {
      const value = session.get(name);
      if (value === null || value === undefined) return [];
      return [`- ${fieldWords(name)}: ${phraseValue(value as Value, kinds.get(name)!)}`];
    });
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
    fields,
    sampling: { drawn: files.length, seed, reused: false },
    files,
    roster: rosterBlock(files.map((file) => file.id)),
  };
}

/** The records of a JSON array, or of JSON Lines; a message naming the bad line otherwise. */
function parseSessions(text: string): Session[] | string {
  const trimmed = text.trim();
  let records: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return "The sessions file is not a JSON array.";
      records = parsed;
    } catch (error) {
      return `The sessions file is not valid JSON: ${(error as Error).message}.`;
    }
  } else {
    records = [];
    const all = text.split(/\r?\n/);
    for (const [index, line] of all.entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        return `Line ${index + 1} of the sessions file is not valid JSON. Each line holds one session as a JSON object.`;
      }
    }
  }
  const sessions: Session[] = [];
  for (const [index, record] of records.entries()) {
    if (!isRecord(record) || Array.isArray(record))
      return `Session ${index + 1} is not a JSON object. Each session is one object of field names and values.`;
    sessions.push(new Map(Object.entries(record)));
  }
  if (sessions.length === 0) return "The sessions file holds no sessions.";
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

/** A whole number, or one decimal below 10 when the value is not whole. */
function roundValue(value: number): number {
  if (Number.isInteger(value)) return value;
  return Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

function phraseValue(value: Value, kind: MeasureKind): string {
  if (kind === "yes/no") return value ? "yes" : "no";
  return `about ${roundValue(value as number)}`;
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
