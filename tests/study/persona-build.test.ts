// buildPersonas turns an export of real sessions into persona files and a roster block.
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { buildPersonas, type PersonaBuild } from "../../src/study/persona-build.js";
import { parseResolvedPersona } from "../../src/study/persona.js";

const lines = (...records: unknown[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n");

function built(result: PersonaBuild): Extract<PersonaBuild, { ok: true }> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

const background = (contents: string): string =>
  (parse(contents) as { background: string }).background;

describe("which fields become measures", () => {
  it("reads finite numbers and booleans and skips every other field with its reason", () => {
    const result = built(
      buildPersonas({
        // 1e999 parses to Infinity, which JSON itself cannot carry.
        sessionsText: [
          '{"rounds": 2, "comment": "fun", "device": {"w": 390}, "score": 1e999, "tags": [1], "mixed": 1, "empty": null, "hinted": true}',
          '{"rounds": 4, "comment": null, "score": 3, "mixed": false, "empty": null, "hinted": false}',
        ].join("\n"),
      }),
    );
    expect(result.fields).toEqual([
      { name: "rounds", used: true, kind: "number" },
      { name: "comment", used: false, reason: "text" },
      { name: "device", used: false, reason: "nested value" },
      { name: "score", used: false, reason: "not a finite number" },
      { name: "tags", used: false, reason: "nested value" },
      { name: "mixed", used: false, reason: "mixed types" },
      { name: "empty", used: false, reason: "no values" },
      { name: "hinted", used: true, kind: "yes/no" },
    ]);
  });

  it.each([
    "id",
    "ID",
    "session_id",
    "userId",
    "accountID",
    "visitor-uuid",
    "timestamp",
    "eventTimestamp",
    "created_at",
    "updatedAt",
    "date",
    "visit_date",
    "firstVisitDate",
    "email",
    "ip",
    "client_ip",
    "session",
    "user",
  ])("skips %s for its name even when its values are numbers", (name) => {
    const result = built(buildPersonas({ sessionsText: lines({ [name]: 7, rounds: 1 }) }));
    expect(result.fields[0]).toEqual({ name, used: false, reason: "identifier or time" });
  });

  it.each(["paid_rounds", "valid_answers", "idle_seconds", "session_count", "user_rating"])(
    "keeps %s, whose name only contains an identifier word inside another word or as a qualifier",
    (name) => {
      const result = built(buildPersonas({ sessionsText: lines({ [name]: 2 }) }));
      expect(result.fields).toEqual([{ name, used: true, kind: "number" }]);
    },
  );

  it("writes nothing from a skipped field into any persona", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines({ user_id: 4242, note: "left early", rounds: 3 }),
      }),
    );
    const persona = parse(result.files[0]!.contents) as Record<string, unknown>;
    expect(Object.keys(persona)).toEqual(["schema", "id", "name", "background"]);
    expect(background(result.files[0]!.contents).split("\n").slice(1)).toEqual([
      "- rounds: about 3",
    ]);
  });

  it("refuses an export with no measure at all", () => {
    const result = buildPersonas({ sessionsText: lines({ id: 1, note: "a" }) });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_NO_MEASURES" },
      fields: [
        { name: "id", used: false, reason: "identifier or time" },
        { name: "note", used: false, reason: "text" },
      ],
    });
  });
});

describe("default phrasing", () => {
  it("writes one line per measure from the field name and the rounded value", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines({
          rounds_played: 3,
          picturesViewedPerRound: 2.14,
          used_a_hint: false,
          started_another_game: true,
          minutes_on_site: 12.6,
        }),
      }),
    );
    expect(result.files.map((file) => file.name)).toEqual(["visitor-001.yaml"]);
    expect(background(result.files[0]!.contents)).toBe(
      [
        "How this person used this app on an earlier visit, which is how they use it now:",
        "- rounds played: about 3",
        "- pictures viewed per round: about 2.1",
        "- used a hint: no",
        "- started another game: yes",
        "- minutes on site: about 13",
      ].join("\n"),
    );
  });
});

describe("rounding", () => {
  it.each([
    [0, "0"],
    [1, "about 1"],
    [2.04, "about 2"],
    [9.96, "about 10"],
    [9.94, "about 9.9"],
    [10.5, "about 11"],
    [-2.35, "about -2.4"],
    [140, "about 140"],
  ])("renders %s as %s", (value, phrase) => {
    const result = built(buildPersonas({ sessionsText: lines({ recipes_saved: value }) }));
    expect(background(result.files[0]!.contents).split("\n")[1]).toBe(`- recipes saved: ${phrase}`);
  });
});

describe("each session's own measures", () => {
  it("leaves out a measure the session has no value for, and skips a session with none", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines(
          { photos_rated: 5, shared: null },
          { photos_rated: null, shared: null },
          { shared: true },
        ),
        seed: 1,
      }),
    );
    expect(result.sessions).toEqual({ read: 3, usable: 2 });
    expect(
      result.files.map((file) => background(file.contents).split("\n").slice(1)).sort(),
    ).toEqual([["- photos rated: about 5"], ["- shared: yes"]]);
  });

  it("writes files the persona parser reads with no warnings, named after the prefix", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines({ quizzes_finished: 2 }, { quizzes_finished: 6 }),
        prefix: "quiz-taker",
      }),
    );
    expect(result.files.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "quiz-taker-001", name: "quiz-taker-001.yaml" },
      { id: "quiz-taker-002", name: "quiz-taker-002.yaml" },
    ]);
    for (const [index, file] of result.files.entries()) {
      const warnings: string[] = [];
      const persona = parseResolvedPersona(
        parse(file.contents),
        { id: "fallback", name: "Fallback" },
        warnings,
      );
      expect(warnings).toEqual([]);
      expect(persona).toMatchObject({ id: file.id, name: `Quiz Taker ${index + 1}` });
      expect(persona.background?.split("\n")).toHaveLength(2);
    }
  });

  it("prints a participants block that gives each participant one persona", () => {
    const result = built(buildPersonas({ sessionsText: lines({ a: 1 }, { a: 2 }) }));
    expect(parse(result.roster)).toEqual({
      participants: [
        { id: "visitor-001", persona: "visitor-001" },
        { id: "visitor-002", persona: "visitor-002" },
      ],
    });
  });
});

describe("sampling", () => {
  const sessions = (count: number) =>
    lines(...Array.from({ length: count }, (_, index) => ({ pages_read: index })));
  const drawnValues = (result: PersonaBuild) =>
    built(result).files.map((file) => background(file.contents).split("\n")[1]);

  it("draws every session, up to 50, when no count is given", () => {
    expect(built(buildPersonas({ sessionsText: sessions(7) })).sampling).toEqual({
      drawn: 7,
      seed: 1,
      reused: false,
    });
    const many = built(buildPersonas({ sessionsText: sessions(80) }));
    expect(many.files).toHaveLength(50);
    expect(new Set(drawnValues(many)).size).toBe(50);
  });

  it("gives the same files for the same input and seed, and another draw for another seed", () => {
    const first = buildPersonas({ sessionsText: sessions(30), count: 10, seed: 7 });
    const again = buildPersonas({ sessionsText: sessions(30), count: 10, seed: 7 });
    const other = buildPersonas({ sessionsText: sessions(30), count: 10, seed: 8 });
    expect(again).toEqual(first);
    expect(drawnValues(other)).not.toEqual(drawnValues(first));
    expect(new Set(drawnValues(first)).size).toBe(10);
  });

  it("reuses sessions evenly when the count is above the number of sessions, and says so", () => {
    const result = built(buildPersonas({ sessionsText: sessions(3), count: 7 }));
    expect(result.sampling).toEqual({ drawn: 7, seed: 1, reused: true });
    const uses = new Map<string | undefined, number>();
    for (const value of drawnValues(result)) uses.set(value, (uses.get(value) ?? 0) + 1);
    expect([...uses.values()].sort()).toEqual([2, 2, 3]);
  });

  it.each([
    { count: 0 },
    { count: 101 },
    { count: 2.5 },
    { seed: -1 },
    { prefix: "../x" },
    { prefix: "a".repeat(37) },
  ])("refuses %o", (options) => {
    expect(buildPersonas({ sessionsText: sessions(3), ...options })).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_INVALID_OPTION" },
    });
  });
});

describe("--measures", () => {
  const export_ = lines({ rounds: 2, hints: 1, user_id: 9, note: "x", streak: 4 });

  it("narrows the measures to the named fields", () => {
    const result = built(buildPersonas({ sessionsText: export_, measures: ["streak", "rounds"] }));
    expect(result.fields.filter((field) => field.used).map((field) => field.name)).toEqual([
      "rounds",
      "streak",
    ]);
    expect(result.fields.find((field) => field.name === "hints")).toEqual({
      name: "hints",
      used: false,
      reason: "not named in --measures",
    });
  });

  it.each([
    ["user_id", "identifier or time"],
    ["note", "text"],
    ["missing", "not in the sessions file"],
  ])("refuses a named field that cannot be a measure: %s", (name, reason) => {
    expect(buildPersonas({ sessionsText: export_, measures: [name] })).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_INVALID_MEASURE", field: name, reason },
    });
  });
});

describe("the sessions file", () => {
  it("reads one JSON array the same as JSON Lines", () => {
    const records = [{ rounds: 1 }, { rounds: 5 }];
    expect(buildPersonas({ sessionsText: JSON.stringify(records) })).toEqual(
      buildPersonas({ sessionsText: lines(...records) }),
    );
  });

  it.each([
    ['{"rounds": 1}\n{"rounds": 2,\n', 2],
    ['{"rounds": 1}\n[1, 2]\n', 2],
    ["\n\n", undefined],
  ])("names the line that is not a session object", (text, line) => {
    const result = buildPersonas({ sessionsText: text });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_INVALID_SESSIONS", ...(line ? { line } : {}) },
    });
  });
});
