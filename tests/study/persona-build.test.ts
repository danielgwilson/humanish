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
