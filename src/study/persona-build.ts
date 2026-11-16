// Turn an export of real sessions into persona files: one file per drawn session, whose background
// states that session's measures, and the `participants:` block that assigns them. Pure: the
// `humanish personas build` command reads the files and writes the results.
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify } from "yaml";

import { isRecord } from "../run/type-guards.js";
import { personaTitleFromId } from "./persona-resolve.js";

/** The most sessions drawn when `--count` is not given. */
export const DEFAULT_PERSONA_COUNT = 50;
/** A study has at most 100 participants, so a build has at most 100 personas. */
const MAX_PERSONA_COUNT = 100;
export const DEFAULT_PERSONA_SEED = 1;
export const DEFAULT_PERSONA_PREFIX = "visitor";

// The first line of each background when no habits file gives an intro. Participants read it.
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
  /** A `humanish.habits.v1` YAML file: the adopter's own intro and sentence for each measure. */
  habitsText?: string;
}

type MeasureKind = "number" | "yes/no";

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
  | "HUMANISH_PERSONAS_INVALID_OPTION"
  | "HUMANISH_PERSONAS_INVALID_HABITS";

interface PersonaBuildError {
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
      warnings: string[];
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
  const habits = input.habitsText === undefined ? undefined : parseHabits(input.habitsText);
  if (typeof habits === "string")
    return fail({ code: "HUMANISH_PERSONAS_INVALID_HABITS", message: habits });
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
  const kindError = habits && habitKindError(habits, measures);
  if (kindError)
    return fail({ code: "HUMANISH_PERSONAS_INVALID_HABITS", message: kindError }, narrowed);
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
      hasValue(session, name)
        ? [measureLine(name, session.get(name) as Value, kind, habits?.measures.get(name))]
        : [],
    );
    const persona = {
      schema: "humanish.persona.v1",
      id,
      name: `${personaTitleFromId(prefix)} ${number}`,
      background: [habits?.intro ?? DEFAULT_INTRO, ...lines].join("\n"),
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
    warnings: [...(habits?.measures.keys() ?? [])]
      .filter((name) => !measures.some((measure) => measure.name === name))
      .map(
        (name) =>
          `The habits file phrases ${name}, which is not a measure in this build, so its sentences are not used. Check the name against the fields listed above.`,
      ),
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
    if (!isRecord(record))
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

/**
 * `- rounds played: about 3`, or the habits file's sentence for the value. An exact 0 is not
 * approximate, so by default it reads `0`.
 */
function measureLine(name: string, value: Value, kind: MeasureKind, forms?: HabitForms): string {
  if (kind === "yes/no") {
    const sentence = forms?.[value ? "true" : "false"];
    return `- ${sentence ?? `${fieldWords(name)}: ${value ? "yes" : "no"}`}`;
  }
  const rounded = roundValue(value as number);
  const form =
    (rounded === 0 ? forms?.zero : rounded === 1 ? forms?.one : undefined) ?? forms?.other;
  if (form !== undefined) return `- ${form.replaceAll("{value}", String(rounded))}`;
  return `- ${fieldWords(name)}: ${value === 0 ? "0" : `about ${rounded}`}`;
}

const HABITS_SCHEMA = "humanish.habits.v1";
const HABITS_KEYS = new Set(["schema", "intro", "measures"]);
const NUMBER_FORMS = ["zero", "one", "other"] as const;
const YES_NO_FORMS = ["true", "false"] as const;
const HABIT_TEXT_MAX_CHARS = 280;

type HabitForms = Partial<
  Record<(typeof NUMBER_FORMS)[number] | (typeof YES_NO_FORMS)[number], string>
>;
interface Habits {
  intro?: string;
  measures: Map<string, HabitForms>;
}

/** The habits file, checked; a message naming the first problem otherwise. */
function parseHabits(text: string): Habits | string {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return `The habits file is not valid YAML: ${(error as Error).message}`;
  }
  if (!isRecord(raw) || raw.schema !== HABITS_SCHEMA)
    return `The habits file must start with \`schema: ${HABITS_SCHEMA}\`.`;
  const unknown = Object.keys(raw).find((key) => !HABITS_KEYS.has(key));
  if (unknown !== undefined)
    return `The habits file has an unknown key ${JSON.stringify(unknown)}. It takes schema, intro and measures.`;
  const intro = raw.intro === undefined ? undefined : habitText(raw.intro, "intro", false);
  if (intro !== undefined && !intro.ok) return intro.message;
  if (raw.measures !== undefined && !isRecord(raw.measures))
    return "measures in the habits file must be a mapping from a field name to its sentences.";
  const measures = new Map<string, HabitForms>();
  for (const [name, entry] of Object.entries(raw.measures ?? {})) {
    if (!isRecord(entry))
      return `measures.${name} in the habits file must be a mapping of forms: zero, one and other for a number, true and false for a true/false field.`;
    const forms: HabitForms = {};
    for (const [form, value] of Object.entries(entry)) {
      const isNumberForm = (NUMBER_FORMS as readonly string[]).includes(form);
      if (!isNumberForm && !(YES_NO_FORMS as readonly string[]).includes(form))
        return `measures.${name}.${form} in the habits file is not a form. A number takes zero, one and other; a true/false field takes true and false.`;
      const checked = habitText(value, `measures.${name}.${form}`, isNumberForm);
      if (!checked.ok) return checked.message;
      forms[form as keyof HabitForms] = checked.text;
    }
    measures.set(name, forms);
  }
  return { ...(intro === undefined ? {} : { intro: intro.text }), measures };
}

/** One line of text, at most 280 characters, whose only placeholder is `{value}` where allowed. */
function habitText(
  value: unknown,
  where: string,
  takesValue: boolean,
): { ok: true; text: string } | { ok: false; message: string } {
  const fail = (problem: string) => ({
    ok: false as const,
    message: `${where} in the habits file ${problem}`,
  });
  if (typeof value !== "string" || !value.trim()) return fail("must be text.");
  const text = value.trim();
  if (/[\r\n]/.test(text))
    return fail("must be one line; each sentence is one line of the persona.");
  if (text.length > HABIT_TEXT_MAX_CHARS)
    return fail(`is over ${HABIT_TEXT_MAX_CHARS} characters; shorten it.`);
  const placeholders = text.match(/\{[^}]*\}/g) ?? [];
  const other = placeholders.find((placeholder) => placeholder !== "{value}");
  if (other !== undefined)
    return fail(`uses ${other}. The only placeholder is {value}, the rounded value.`);
  if (!takesValue && placeholders.length > 0)
    return fail("uses {value}, which only a number form can fill.");
  return { ok: true, text };
}

/** A number measure phrased with true/false forms, or the other way round. */
function habitKindError(
  habits: Habits,
  measures: ReadonlyArray<{ name: string; kind: MeasureKind }>,
): string | undefined {
  for (const { name, kind } of measures) {
    const forms = Object.keys(habits.measures.get(name) ?? {});
    const expected: readonly string[] = kind === "yes/no" ? YES_NO_FORMS : NUMBER_FORMS;
    const wrong = forms.find((form) => !expected.includes(form));
    if (wrong !== undefined)
      return `measures.${name}.${wrong} in the habits file does not fit ${name}, whose values are ${kind === "yes/no" ? "true and false; use the true and false forms" : "numbers; use the zero, one and other forms"}.`;
  }
  return undefined;
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
