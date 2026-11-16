// buildPersonas turns an export of real sessions into persona files and a roster block. The
// examples are a fictional recipe site and a fictional trip planner.
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { buildPersonas, type PersonaBuild } from "../../src/study/persona-build.js";
import { parseResolvedPersona, PERSONA_BACKGROUND_MAX_BYTES } from "../../src/study/persona.js";

const lines = (...records: unknown[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n");

function built(result: PersonaBuild): Extract<PersonaBuild, { ok: true }> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

const background = (contents: string): string =>
  (parse(contents) as { background: string }).background;
/** The habit lines of a built background, without its intro line. */
const habitLines = (contents: string): string[] => background(contents).split("\n").slice(1);
const firstHabits = (result: PersonaBuild): string[] =>
  habitLines(built(result).files[0]!.contents);

describe("which fields become measures", () => {
  it("reads finite numbers and booleans and skips every other field with its reason", () => {
    const result = built(
      buildPersonas({
        // 1e999 parses to Infinity, which JSON itself cannot carry.
        sessionsText: [
          '{"stops": 2, "comment": "fun", "device": {"w": 390}, "score": 1e999, "tags": [1], "mixed": 1, "empty": null, "shared": true, "---": 3}',
          '{"stops": 4, "comment": null, "score": 3, "mixed": false, "empty": null, "shared": false, "---": 4}',
        ].join("\n"),
      }),
    );
    expect(result.fields).toEqual([
      { name: "stops", used: true, kind: "number" },
      { name: "comment", used: false, reason: "text" },
      { name: "device", used: false, reason: "nested value" },
      { name: "score", used: false, reason: "not a finite number" },
      { name: "tags", used: false, reason: "nested value" },
      { name: "mixed", used: false, reason: "mixed types" },
      { name: "empty", used: false, reason: "no values" },
      { name: "shared", used: true, kind: "yes/no" },
      { name: "---", used: false, reason: "no letters or digits" },
    ]);
  });

  it.each([
    "id",
    "ID",
    "session_id",
    "userId",
    "accountID",
    "USERID",
    "sessionid",
    "visitor-uuid",
    "timestamp",
    "eventTimestamp",
    "created_at",
    "updatedAt",
    "created_ts",
    "start_time",
    "datetime_utc",
    "epoch_ms",
    "date",
    "visit_date",
    "email",
    "client_ip",
    "session_key",
    "api_token",
    "row_hash",
    "phone",
    "account",
    "home_address",
    "zip",
    "lat",
    "lng",
    "longitude",
    "display_name",
    "session",
    "user",
  ])("skips %s for its name even when its values are small numbers", (name) => {
    const result = built(buildPersonas({ sessionsText: lines({ [name]: 7, stops_added: 1 }) }));
    expect(result.fields[0]).toEqual({ name, used: false, reason: "identifier or time" });
  });

  it.each(["session_count", "user_rating", "searches_per_visit"])("keeps %s", (name) => {
    const result = built(buildPersonas({ sessionsText: lines({ [name]: 2 }) }));
    expect(result.fields).toEqual([{ name, used: true, kind: "number" }]);
  });

  it("skips a field with a whole number of a billion or more in any session", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines(
          { recipes_opened: 3, sync: 4, plan: 99_812_377 },
          { recipes_opened: 5, sync: 1_731_000_000_004, plan: 2 },
        ),
      }),
    );
    expect(result.fields).toEqual([
      { name: "recipes_opened", used: true, kind: "number" },
      { name: "sync", used: false, reason: "identifier or time" },
      { name: "plan", used: true, kind: "number" },
    ]);
  });

  it("writes nothing from a skipped field into any persona", () => {
    const result = built(
      buildPersonas({ sessionsText: lines({ user_id: 4242, note: "left early", stops_added: 3 }) }),
    );
    const persona = parse(result.files[0]!.contents) as Record<string, unknown>;
    expect(Object.keys(persona)).toEqual(["schema", "id", "name", "background"]);
    expect(habitLines(result.files[0]!.contents)).toEqual(["- stops added: about 3"]);
  });

  it("refuses an export with no measure at all, and reports the sessions it read", () => {
    const result = buildPersonas({ sessionsText: lines({ id: 1, note: "a" }, { id: 2 }) });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_NO_MEASURES" },
      sessions: { read: 2, usable: 0 },
      fields: [
        { name: "id", used: false, reason: "identifier or time" },
        { name: "note", used: false, reason: "text" },
      ],
    });
  });
});

describe("--measures", () => {
  const exported = lines({
    stops_added: 2,
    routes_compared: 1,
    trip_id: 9,
    note: "x",
    legs: [1],
    start_time: 4,
    booking: 4_400_000_123,
  });
  const used = (result: PersonaBuild) =>
    built(result)
      .fields.filter((field) => field.used)
      .map((field) => field.name);

  it("narrows the measures to the named fields", () => {
    const result = built(buildPersonas({ sessionsText: exported, measures: ["stops_added"] }));
    expect(used(result)).toEqual(["stops_added"]);
    expect(result.fields.find((field) => field.name === "routes_compared")).toEqual({
      name: "routes_compared",
      used: false,
      reason: "not named in --measures",
    });
    expect(result.fields.find((field) => field.name === "trip_id")).toEqual({
      name: "trip_id",
      used: false,
      reason: "identifier or time",
    });
  });

  it("reads a named field that its name or a large value would skip", () => {
    const result = built(
      buildPersonas({ sessionsText: exported, measures: ["start_time", "booking"] }),
    );
    expect(used(result)).toEqual(["start_time", "booking"]);
    expect(habitLines(result.files[0]!.contents)).toEqual([
      "- start time: about 4",
      "- booking: about 4400000000",
    ]);
  });

  it.each(["note", "legs", "missing"])(
    "refuses a named field that cannot be a measure: %s",
    (name) => {
      expect(buildPersonas({ sessionsText: exported, measures: [name] })).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_PERSONAS_INVALID_MEASURE" },
      });
    },
  );
});

describe("default phrasing", () => {
  it("writes the intro and one line per measure from the field name and the rounded value", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines({
          recipes_opened: 3,
          searchesPerVisit: 2.14,
          saved_a_recipe: false,
          shared_the_plan: true,
          minutes_on_site: 12.6,
        }),
      }),
    );
    expect(result.files.map((file) => file.name)).toEqual(["visitor-001.yaml"]);
    expect(background(result.files[0]!.contents)).toBe(
      [
        "How this person used this app on an earlier visit, which is how they use it now:",
        "- recipes opened: about 3",
        "- searches per visit: about 2.1",
        "- saved a recipe: no",
        "- shared the plan: yes",
        "- minutes on site: about 13",
      ].join("\n"),
    );
  });

  it.each([
    [0, "0"],
    [1, "about 1"],
    [2.04, "about 2"],
    [9.96, "about 10"],
    [9.94, "about 9.9"],
    [10.5, "about 11"],
    [-2.35, "about -2.4"],
    [140, "about 140"],
    [999.4, "about 999"],
    [12_345, "about 12300"],
    [99_812_377, "about 99800000"],
    [-45_678.9, "about -45700"],
  ])("renders %s as %s", (value, phrase) => {
    expect(firstHabits(buildPersonas({ sessionsText: lines({ recipes_saved: value }) }))).toEqual([
      `- recipes saved: ${phrase}`,
    ]);
  });

  it("strips control characters from a field name it phrases", () => {
    expect(
      firstHabits(buildPersonas({ sessionsText: lines({ "stops\u001b[2J_added": 2 }) })),
    ).toEqual(["- stops [2 j added: about 2"]);
  });

  it("refuses a build whose background would pass the persona background limit", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`${"w".repeat(80)}_${index}`, index + 1]),
    );
    expect(buildPersonas({ sessionsText: lines(wide) })).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_BACKGROUND_TOO_LONG" },
    });
    expect(Object.keys(wide).length * 90).toBeGreaterThan(PERSONA_BACKGROUND_MAX_BYTES);
  });
});

describe("each session's own measures", () => {
  it("leaves out a measure the session has no value for, and skips a session with none", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines(
          { stops_added: 5, shared: null },
          { stops_added: null, shared: null },
          { shared: true },
        ),
      }),
    );
    expect(result.sessions).toEqual({ read: 3, usable: 2 });
    expect(result.files.map((file) => habitLines(file.contents)).sort()).toEqual([
      ["- shared: yes"],
      ["- stops added: about 5"],
    ]);
  });

  it("writes files the persona parser reads with no warnings, named after the prefix", () => {
    const result = built(
      buildPersonas({
        sessionsText: lines({ stops_added: 2 }, { stops_added: 6 }),
        prefix: "trip-planner",
      }),
    );
    expect(result.files.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "trip-planner-001", name: "trip-planner-001.yaml" },
      { id: "trip-planner-002", name: "trip-planner-002.yaml" },
    ]);
    for (const [index, file] of result.files.entries()) {
      const warnings: string[] = [];
      const persona = parseResolvedPersona(
        parse(file.contents),
        { id: "fallback", name: "Fallback" },
        warnings,
      );
      expect(warnings).toEqual([]);
      expect(persona).toMatchObject({ id: file.id, name: `Trip Planner ${index + 1}` });
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
    lines(...Array.from({ length: count }, (_, index) => ({ stops_added: index })));
  const drawnValues = (result: PersonaBuild) =>
    built(result).files.map((file) => habitLines(file.contents)[0]);

  it("draws a fixed order for a fixed seed", () => {
    expect(drawnValues(buildPersonas({ sessionsText: sessions(6), seed: 1 }))).toEqual([
      "- stops added: about 4",
      "- stops added: about 5",
      "- stops added: about 2",
      "- stops added: about 3",
      "- stops added: 0",
      "- stops added: about 1",
    ]);
  });

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

describe("the sessions file", () => {
  it("reads one JSON array the same as JSON Lines", () => {
    const records = [{ stops_added: 1 }, { stops_added: 5 }];
    expect(buildPersonas({ sessionsText: JSON.stringify(records) })).toEqual(
      buildPersonas({ sessionsText: lines(...records) }),
    );
  });

  it("reads JSON Lines that start with a byte order mark", () => {
    expect(built(buildPersonas({ sessionsText: `﻿${lines({ stops_added: 2 })}` })).sessions).toEqual(
      { read: 1, usable: 1 },
    );
  });

  it("reads a JSON array of 200,000 sessions", () => {
    const text = JSON.stringify(
      Array.from({ length: 200_000 }, (_, index) => ({ stops_added: index % 9 })),
    );
    expect(built(buildPersonas({ sessionsText: text, count: 3 })).sessions).toEqual({
      read: 200_000,
      usable: 200_000,
    });
  });

  it("never echoes the file's content when it is not valid JSON", () => {
    const secret = "Ana Ruiz";
    for (const text of [
      `[{"stops_added": 1, "note": "${secret}"},]`,
      `{"stops_added": 1, "note": "${secret}"`,
    ]) {
      const result = buildPersonas({ sessionsText: text });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_PERSONAS_INVALID_SESSIONS" },
      });
      if (result.ok) continue;
      expect(result.error.message).not.toContain("Ruiz");
      expect(result.error.message).not.toContain("stops_added");
    }
  });

  it.each([
    '{"stops_added": 1}\n{"stops_added": 2,\n',
    '{"stops_added": 1}\n[1, 2]\n',
    "[1, 2]",
    "\n\n",
  ])("refuses a file that is not sessions: %j", (text) => {
    expect(buildPersonas({ sessionsText: text })).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_INVALID_SESSIONS" },
    });
  });
});

describe("a habits file", () => {
  const habitsText = [
    "schema: humanish.habits.v1",
    'intro: "How this cook uses the recipe site on any visit:"',
    "measures:",
    "  recipes_opened:",
    '    other: "they open about {value} recipes before choosing one"',
    '    one: "they open one recipe and cook it"',
    '    zero: "they leave before opening a recipe"',
    "  saved_a_recipe:",
    '    "true": "they save the recipe they cook"',
    '    "false": "they never save a recipe"',
  ].join("\n");
  const bodies = (records: unknown[], habits = habitsText) =>
    built(buildPersonas({ sessionsText: lines(...records), habitsText: habits })).files.map(
      (file) => background(file.contents).split("\n"),
    );

  it("phrases each listed measure with its form for zero, one, any other value, true and false", () => {
    const written = bodies([
      { recipes_opened: 0, saved_a_recipe: true, minutes_reading: 4 },
      { recipes_opened: 1.04, saved_a_recipe: false },
      { recipes_opened: 3.46 },
      { recipes_opened: 0.04 },
    ]).sort((a, b) => a[1]!.localeCompare(b[1]!));
    expect(written).toEqual([
      [
        "How this cook uses the recipe site on any visit:",
        "- they leave before opening a recipe",
        "- they save the recipe they cook",
        "- minutes reading: about 4",
      ],
      [
        "How this cook uses the recipe site on any visit:",
        "- they open about 0 recipes before choosing one",
      ],
      [
        "How this cook uses the recipe site on any visit:",
        "- they open about 3.5 recipes before choosing one",
      ],
      [
        "How this cook uses the recipe site on any visit:",
        "- they open one recipe and cook it",
        "- they never save a recipe",
      ],
    ]);
  });

  it("uses the form for any other value when zero or one has none, and the default with no form", () => {
    const habits = [
      "schema: humanish.habits.v1",
      "measures:",
      '  routes_compared: { other: "they compare about {value} routes" }',
      '  stops_added: { one: "they add one stop" }',
    ].join("\n");
    expect(
      bodies([{ routes_compared: 1, stops_added: 2 }], habits).map((body) => body.slice(1)),
    ).toEqual([["- they compare about 1 routes", "- stops added: about 2"]]);
  });

  it("warns about a listed measure the build does not use", () => {
    const result = built(buildPersonas({ sessionsText: lines({ recipes_opened: 2 }), habitsText }));
    expect(result.warnings).toHaveLength(1);
  });

  it.each([
    ["a missing schema", "measures: {}"],
    ["another schema", "schema: humanish.persona.v1"],
    ["an unknown top-level key", "schema: humanish.habits.v1\nintros: x"],
    ["an unknown form", 'schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { ohter: "x" }'],
    [
      "a placeholder other than {value}",
      'schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { other: "about {count} recipes" }',
    ],
    [
      "an unclosed placeholder",
      'schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { other: "about {value recipes" }',
    ],
    [
      "a stray brace",
      'schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { other: "about {value}} recipes" }',
    ],
    [
      "{value} in a true or false form",
      'schema: humanish.habits.v1\nmeasures:\n  saved_a_recipe: { "true": "saved {value}" }',
    ],
    [
      "number forms on a true/false measure",
      'schema: humanish.habits.v1\nmeasures:\n  saved_a_recipe: { other: "saved" }',
    ],
    [
      "true and false forms on a number measure",
      'schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { "true": "opened" }',
    ],
    [
      "a form that is not one line of text",
      'schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { other: "a\\nb" }',
    ],
    [
      "a form that is not text",
      "schema: humanish.habits.v1\nmeasures:\n  recipes_opened: { other: 3 }",
    ],
    ["an intro over 280 characters", `schema: humanish.habits.v1\nintro: ${"x".repeat(281)}`],
    ["measures that is not a mapping", "schema: humanish.habits.v1\nmeasures: [1]"],
    ["text that is not YAML", "schema: [humanish"],
  ])("refuses %s", (_case, habits) => {
    expect(
      buildPersonas({
        sessionsText: lines({ recipes_opened: 2, saved_a_recipe: true }),
        habitsText: habits,
      }),
    ).toMatchObject({ ok: false, error: { code: "HUMANISH_PERSONAS_INVALID_HABITS" } });
  });
});
