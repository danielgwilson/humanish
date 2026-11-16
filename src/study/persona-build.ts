// Turn an export of real sessions into persona files: one file per drawn session, whose background
// states that session's measures, and the `participants:` block that assigns them. Pure: the
// `humanish personas build` command reads the files and writes the results.
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";

import { isRecord } from "../run/type-guards.js";
import { PARTICIPANT_ID_MAX_CHARS } from "./parse/actors.js";
import { PERSONA_BACKGROUND_MAX_BYTES } from "./persona.js";
import { PERSONA_ID_PATTERN, personaTitleFromId } from "./persona-resolve.js";
import { participantCountReason } from "./routing.js";

/** The most sessions drawn when `--count` is not given. */
export const DEFAULT_PERSONA_COUNT = 50;
export const DEFAULT_PERSONA_SEED = 1;
export const DEFAULT_PERSONA_PREFIX = "visitor";
// Each id is `<prefix>-NNN`, and a participant id holds at most PARTICIPANT_ID_MAX_CHARS.
const PREFIX_MAX_CHARS = PARTICIPANT_ID_MAX_CHARS - 4;

// The first line of each background when no habits file gives an intro. Participants read it.
const DEFAULT_INTRO =
  "How this person used this app on an earlier visit, which is how they use it now:";

export interface PersonaBuildInput {
  /** JSON Lines, or one JSON array, of flat session objects. */
  sessionsText: string;
  count?: number;
  seed?: number;
  /** Only these fields become measures, read even when their name or values look like an id. */
  measures?: readonly string[];
  prefix?: string;
  /** A `humanish.habits.v1` YAML file: the adopter's own intro and sentence for each measure. */
  habitsText?: string;
}

type MeasureKind = "number" | "yes/no";

/** Why a field in the export is not read into any persona. */
export type SkipReason =
  | "identifier or time"
  | "no letters or digits"
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
  | "HUMANISH_PERSONAS_INVALID_HABITS"
  | "HUMANISH_PERSONAS_BACKGROUND_TOO_LONG";

/** Sessions in the export, and how many have at least one measure. */
interface SessionCounts {
  read: number;
  usable: number;
}

export type PersonaBuild =
  | {
      ok: true;
      sessions: SessionCounts;
      fields: FieldReport[];
      sampling: { drawn: number; seed: number; reused: boolean };
      files: Array<{ id: string; name: string; contents: string }>;
      /** A `participants:` block that gives each participant one built persona. */
      roster: string;
      warnings: string[];
    }
  | {
      ok: false;
      error: { code: PersonaBuildErrorCode; message: string };
      fields: FieldReport[];
      /** Present once the sessions file has been read. */
      sessions?: SessionCounts;
    };

type Session = Record<string, unknown>;
type Measure = { name: string; kind: MeasureKind };

/** Build the personas, or say why not. The same input always gives the same files. */
export function buildPersonas(input: PersonaBuildInput): PersonaBuild {
  const option = optionError(input);
  if (option)
    return {
      ok: false,
      error: { code: "HUMANISH_PERSONAS_INVALID_OPTION", message: option },
      fields: [],
    };
  const sessions = parseSessions(input.sessionsText);
  if (typeof sessions === "string")
    return {
      ok: false,
      error: { code: "HUMANISH_PERSONAS_INVALID_SESSIONS", message: sessions },
      fields: [],
    };
  const named = input.measures === undefined ? undefined : new Set(input.measures);
  const fields = classifyFields(sessions, named);
  const measures = fields.flatMap((field) => (field.used ? [field] : []));
  const hasValue = (session: Session, name: string) =>
    session[name] !== null && session[name] !== undefined;
  const usable = sessions.filter((session) => measures.some(({ name }) => hasValue(session, name)));
  const counts = { read: sessions.length, usable: usable.length };
  const fail = (code: PersonaBuildErrorCode, message: string): PersonaBuild => ({
    ok: false,
    error: { code, message },
    fields,
    sessions: counts,
  });
  const namedError = named && measuresError(fields, named);
  if (namedError) return fail("HUMANISH_PERSONAS_INVALID_MEASURE", namedError);
  if (measures.length === 0)
    return fail(
      "HUMANISH_PERSONAS_NO_MEASURES",
      "No field in the sessions file is a measure. A persona reads only fields whose values are all numbers or all true and false, and skips fields that look like an identifier or a time unless --measures names them. Add numeric or true/false columns to the export, or name the measures with --measures.",
    );
  const habits = input.habitsText === undefined ? undefined : parseHabits(input.habitsText);
  if (typeof habits === "string") return fail("HUMANISH_PERSONAS_INVALID_HABITS", habits);
  const kindError = habits && habitKindError(habits, measures);
  if (kindError) return fail("HUMANISH_PERSONAS_INVALID_HABITS", kindError);

  const count = input.count ?? Math.min(usable.length, DEFAULT_PERSONA_COUNT);
  const seed = input.seed ?? DEFAULT_PERSONA_SEED;
  const prefix = input.prefix ?? DEFAULT_PERSONA_PREFIX;
  const files = [];
  for (const [index, session] of drawSessions(usable, count, seed).entries()) {
    const number = index + 1;
    const id = `${prefix}-${String(number).padStart(3, "0")}`;
    const lines = measures.flatMap(({ name }) =>
      hasValue(session, name)
        ? [measureLine(name, session[name] as number | boolean, habits?.measures.get(name))]
        : [],
    );
    const background = [habits?.intro ?? DEFAULT_INTRO, ...lines].join("\n");
    if (Buffer.byteLength(background, "utf8") > PERSONA_BACKGROUND_MAX_BYTES)
      return fail(
        "HUMANISH_PERSONAS_BACKGROUND_TOO_LONG",
        `${id}'s background would be over the ${PERSONA_BACKGROUND_MAX_BYTES}-byte limit for a persona background, from ${lines.length} measures. Name fewer with --measures.`,
      );
    const persona = {
      schema: "humanish.persona.v1",
      id,
      name: `${personaTitleFromId(prefix)} ${number}`,
      background,
    };
    files.push({ id, name: `${id}.yaml`, contents: stringify(persona, { lineWidth: 0 }) });
  }
  return {
    ok: true,
    sessions: counts,
    fields,
    sampling: { drawn: files.length, seed, reused: count > usable.length },
    files,
    roster: stringify(
      { participants: files.map(({ id }) => ({ id, persona: id })) },
      { lineWidth: 0 },
    ),
    warnings: [...(habits?.measures.keys() ?? [])]
      .filter((name) => !measures.some((measure) => measure.name === name))
      .map(
        (name) =>
          `The habits file phrases ${name}, which is not a measure in this build, so its sentences are not used. Check the name against the fields listed above.`,
      ),
  };
}

function optionError({ count, seed, prefix }: PersonaBuildInput): string | undefined {
  if (count !== undefined && !(Number.isInteger(count) && count >= 1))
    return "--count must be a whole number, 1 or more.";
  const tooMany = count === undefined ? undefined : participantCountReason(count);
  if (tooMany) return `--count is a participant count. ${tooMany}`;
  if (seed !== undefined && !(Number.isSafeInteger(seed) && seed >= 1))
    return "--seed must be a whole number, 1 or more.";
  if (
    prefix !== undefined &&
    !(PERSONA_ID_PATTERN.test(prefix) && prefix.length <= PREFIX_MAX_CHARS)
  )
    return `--prefix must start with a letter or digit, hold only letters, digits, - and _, and be at most ${PREFIX_MAX_CHARS} characters, because it starts each persona id and file name.`;
  return undefined;
}

/** A field `--measures` names that the sessions do not have, or whose values are not a measure. */
function measuresError(
  fields: readonly FieldReport[],
  named: ReadonlySet<string>,
): string | undefined {
  for (const name of named) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field === undefined)
      return `--measures names ${name}, which no session in the sessions file has. Check the spelling against the export's column names.`;
    if (!field.used)
      return `--measures names ${name}, which cannot be a measure: ${SKIP_TEXT[field.reason]}. --measures reads only fields whose values are numbers or true and false.`;
  }
  return undefined;
}

/** Why each skipped field is skipped, in words a person reads. */
export const SKIP_TEXT: Record<SkipReason, string> = {
  "identifier or time":
    "its name or its values look like an identifier or a time; name it in --measures if it is a measure",
  "no letters or digits": "its name has no letters or digits to phrase",
  text: "it holds text, which may be something a person typed",
  "nested value": "it holds a list or an object",
  "mixed types": "it mixes numbers and true/false values",
  "not a finite number": "one of its numbers is too large to read, such as 1e999",
  "no values": "every session has null or no value for it",
  "not named in --measures": "--measures does not name it",
};

/** The sessions of a JSON array, or of JSON Lines; what is wrong otherwise, never the content. */
function parseSessions(text: string): Session[] | string {
  const body = text.replace(/^﻿/, "");
  const records: unknown[] = [];
  const lineOf: number[] = [];
  if (body.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      // The parser's message quotes the text around the error, which may be what a person typed,
      // so only its position is kept.
      const position = /position (\d+)/.exec((error as Error).message)?.[1];
      const line =
        position === undefined ? undefined : body.slice(0, Number(position)).split("\n").length;
      return `The sessions file is not valid JSON${line === undefined ? "" : ` near line ${line}`}. Check it for a trailing comma or a missing quote or bracket.`;
    }
    if (!Array.isArray(parsed)) return "The sessions file is not a JSON array.";
    for (const record of parsed as unknown[]) records.push(record);
  } else {
    for (const [index, json] of body.split(/\r?\n/).entries()) {
      if (!json.trim()) continue;
      try {
        records.push(JSON.parse(json));
        lineOf.push(index + 1);
      } catch {
        return `Line ${index + 1} of the sessions file is not valid JSON. Each line holds one session as a JSON object.`;
      }
    }
  }
  for (const [index, record] of records.entries())
    if (!isRecord(record))
      return `${lineOf[index] === undefined ? `Session ${index + 1}` : `Line ${lineOf[index]}`} of the sessions file is not a JSON object. Each session is one object of field names and values.`;
  if (records.length === 0) return "The sessions file holds no sessions.";
  return records as Session[];
}

/**
 * Each field in order of first appearance, used as a measure or skipped with its reason. A field
 * `named` lists is read whatever its name and size; with `named`, every other field is skipped.
 */
function classifyFields(
  sessions: readonly Session[],
  named: ReadonlySet<string> | undefined,
): FieldReport[] {
  const names = new Set<string>();
  for (const session of sessions) for (const name of Object.keys(session)) names.add(name);
  return [...names].map((name): FieldReport => {
    const skip = (reason: SkipReason): FieldReport => ({ name, used: false, reason });
    if (!/[\p{L}\p{N}]/u.test(name)) return skip("no letters or digits");
    const values = sessions
      .map((session) => session[name])
      .filter((value) => value !== null && value !== undefined);
    const read = readValues(values);
    const kind = read === "number" || read === "yes/no" ? read : undefined;
    if (named?.has(name)) return kind ? { name, used: true, kind } : skip(read as SkipReason);
    if (looksLikeIdentifierOrTime(name)) return skip("identifier or time");
    if (!kind) return skip(read as SkipReason);
    // A whole number this large is a count of milliseconds or seconds since 1970, or an id.
    if (values.some((value) => Number.isInteger(value) && Math.abs(value as number) >= 1e9))
      return skip("identifier or time");
    return named ? skip("not named in --measures") : { name, used: true, kind };
  });
}

function readValues(values: readonly unknown[]): MeasureKind | SkipReason {
  if (values.length === 0) return "no values";
  if (values.some((value) => typeof value === "string")) return "text";
  if (values.some((value) => typeof value === "object")) return "nested value";
  if (values.every((value) => typeof value === "boolean")) return "yes/no";
  if (!values.every((value) => typeof value === "number")) return "mixed types";
  if (!values.every((value) => Number.isFinite(value))) return "not a finite number";
  return "number";
}

// A word anywhere in the name that marks an identifier, a moment, a place or a person, such as
// `session_id`, `api_token`, `start_time` or `display_name`. A measure's name rarely holds one, and
// --measures reads one that does.
const IDENTIFIER_WORDS = new Set([
  ...["id", "uuid", "guid", "key", "token", "hash", "account", "email", "phone", "ip", "name"],
  ...["timestamp", "date", "datetime", "time", "ts", "epoch"],
  ...["address", "zip", "lat", "lng", "lon", "latitude", "longitude"],
]);
// Whole names that hold an identifier, though as one word of a longer name (`session_count`,
// `user_rating`) they qualify a measure.
const IDENTIFIER_NAMES = new Set(["session", "user"]);

function looksLikeIdentifierOrTime(name: string): boolean {
  const words = fieldWords(name).split(" ");
  return (
    words.some((word) => IDENTIFIER_WORDS.has(word)) ||
    IDENTIFIER_NAMES.has(words.join("")) ||
    // `sessionid`, `USERID`
    (words.length === 1 && words[0]!.endsWith("id")) ||
    // `created_at`, `updatedAt`
    (words.length > 1 && words.at(-1) === "at")
  );
}

/** `stops_added` and `stopsAdded` both read `stops added`; `accountID` reads `account id`. */
function fieldWords(name: string): string {
  return name
    .replace(/\p{Cc}/gu, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-\s.]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Below 1,000: a whole number, or one decimal below 10 when the value is not whole, halves away
 * from 0. From 1,000: three significant digits, so no long exact number reaches a persona.
 */
function roundValue(value: number): number {
  if (Math.abs(value) >= 1000) return Number(value.toPrecision(3));
  if (Number.isInteger(value)) return value;
  const scale = Math.abs(value) < 10 ? 10 : 1;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale;
  return rounded === 0 ? 0 : rounded;
}

/**
 * `- stops added: about 3`, or the habits file's sentence for the value. An exact 0 is not
 * approximate, so by default it reads `0`, and only an exact 0 takes the `zero` form.
 */
function measureLine(name: string, value: number | boolean, forms?: HabitForms): string {
  if (typeof value === "boolean") {
    const sentence = forms?.[value ? "true" : "false"];
    return `- ${sentence ?? `${fieldWords(name)}: ${value ? "yes" : "no"}`}`;
  }
  const rounded = roundValue(value);
  const form = (value === 0 ? forms?.zero : rounded === 1 ? forms?.one : undefined) ?? forms?.other;
  if (form !== undefined) return `- ${form.replaceAll("{value}", String(rounded))}`;
  return `- ${fieldWords(name)}: ${value === 0 ? "0" : `about ${rounded}`}`;
}

const HABITS_SCHEMA = "humanish.habits.v1";
const NUMBER_FORMS = ["zero", "one", "other"] as const;
const YES_NO_FORMS = ["true", "false"] as const;

/** One line of a persona: text of at most 280 characters whose only placeholder is `{value}`. */
const habitLine = (takesValue: boolean) =>
  z
    .string({ error: "must be text" })
    .trim()
    .min(1, "must be text")
    .max(280, "is over 280 characters; shorten it")
    .refine(
      (text) => !/[\r\n]/.test(text),
      "must be one line; each sentence is one line of the persona",
    )
    .refine(
      (text) => !/[{}]/.test(text.replaceAll("{value}", "")),
      "has a { or } that is not part of {value}, the only placeholder",
    )
    .refine(
      (text) => takesValue || !text.includes("{value}"),
      "uses {value}, which only a number form can fill",
    );
const habitsSchema = z.strictObject(
  {
    schema: z.literal(HABITS_SCHEMA, { error: `must be ${HABITS_SCHEMA}` }),
    intro: habitLine(false).optional(),
    measures: z
      .record(
        z.string(),
        z.strictObject(
          {
            zero: habitLine(true).optional(),
            one: habitLine(true).optional(),
            other: habitLine(true).optional(),
            true: habitLine(false).optional(),
            false: habitLine(false).optional(),
          },
          {
            error: (issue) =>
              issue.code === "unrecognized_keys"
                ? `has ${issue.keys.join(", ")}, which is not a form. A number takes zero, one and other; a true/false field takes true and false`
                : "must be a mapping of forms: zero, one and other for a number, true and false for a true/false field",
          },
        ),
        { error: "must be a mapping from a field name to its sentences" },
      )
      .optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `has ${issue.keys.join(", ")}, which it does not take. It takes schema, intro and measures`
        : `must be a mapping that starts with schema: ${HABITS_SCHEMA}`,
  },
);

type HabitForms = {
  [form in (typeof NUMBER_FORMS | typeof YES_NO_FORMS)[number]]?: string | undefined;
};
interface Habits {
  intro?: string;
  measures: Map<string, HabitForms>;
}

/** The habits file, checked; a message naming the first problem otherwise. */
function parseHabits(text: string): Habits | string {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return "The habits file is not valid YAML. Check its indentation and quotes.";
  }
  const parsed = habitsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where =
      issue.path.length > 0 ? `${issue.path.join(".")} in the habits file` : "The habits file";
    return `${where} ${issue.message}.`;
  }
  const { intro, measures } = parsed.data;
  return {
    ...(intro === undefined ? {} : { intro }),
    measures: new Map(Object.entries(measures ?? {})),
  };
}

/** A number measure phrased with true/false forms, or the other way round. */
function habitKindError(habits: Habits, measures: readonly Measure[]): string | undefined {
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
