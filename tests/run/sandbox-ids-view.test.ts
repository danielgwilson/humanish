import fc from "fast-check";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { redactSandboxIds, sandboxIdDigest } from "../../src/evidence/redaction.js";
import {
  publicSandboxView,
  scrubSandboxIdBytes,
  scrubSandboxIds,
} from "../../src/run/sandbox-ids.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

// publicSandboxView on a run bundle: with E2B ids, each participant's trace is scrubbed without
// its items joining another participant's in one string, so a hosted run whose traces together
// pass V8's longest string still writes run.json. For any ids, the result must stay what the
// scrub of the whole JSON text returned, which wholeTextView below keeps as the reference.

// Shaped like E2B ids and built at run time, so this file holds none at a sandbox-id key.
const HOST_ID = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const GUEST_ID = ["i", "z5a8c3e1g7", "k2m4o6q9b"].join("");
const label = (id: string): string => `[redacted-sandbox-id ${sandboxIdDigest(id)}]`;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The scrub as it was before it worked one token at a time: the whole value's JSON text, each id
 * replaced longest first, parsed back when anything changed.
 */
function wholeTextView(value: unknown, ids: readonly string[]): unknown {
  const redacted = redactSandboxIds(value);
  if (ids.length === 0) return redacted;
  const text = JSON.stringify(redacted);
  if (text === undefined) return redacted;
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  unique.sort((left, right) => right.length - left.length);
  const scrubbed = unique.reduce((current, id) => current.split(id).join(label(id)), text);
  return scrubbed === text ? redacted : (JSON.parse(scrubbed) as unknown);
}

/** The view's value and its JSON text, or the name of the error it threw. */
function outcome(view: () => unknown): { value: unknown; text: string | undefined } | string {
  try {
    const value = view();
    return { value, text: JSON.stringify(value) };
  } catch (error) {
    return (error as Error).name;
  }
}

/** A bundle of two finished participants, each quoting its desktop's stream URL. */
function twoParticipantBundle() {
  const stream = (marker: string, id: string) => ({
    id: `stream-${marker}`,
    actor: {
      items: [
        { id: `${marker}-1`, kind: "message", text: `${marker} opened https://6080-${id}.e2b.app` },
        { id: `${marker}-2`, kind: "message", text: `${marker} closed the tab` },
      ],
    },
  });
  return {
    runId: "two-participants",
    streams: [stream("first-participant", HOST_ID), stream("second-participant", GUEST_ID)],
  };
}

describe("publicSandboxView on a run bundle", () => {
  it("serializes no two participants' items in one string", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    const view = publicSandboxView(twoParticipantBundle(), [HOST_ID, GUEST_ID]);
    const strings = [
      ...stringify.mock.results.map((result) => result.value as unknown),
      ...parse.mock.calls.map(([text]) => text as unknown),
    ].filter((text): text is string => typeof text === "string");
    vi.restoreAllMocks();

    const joined = strings.filter(
      (text) => text.includes("first-participant") && text.includes("second-participant"),
    );
    expect(joined).toEqual([]);
    expect(view.streams.map((stream) => stream.actor.items[0]!.text)).toEqual([
      `first-participant opened https://6080-${label(HOST_ID)}.e2b.app`,
      `second-participant opened https://6080-${label(GUEST_ID)}.e2b.app`,
    ]);
  });
});

describe("publicSandboxView against the whole-text scrub", () => {
  // An id that starts like an escape's tail: "\n" before the rest of it writes the id in JSON.
  const ESCAPE_ID = ["n", "q7m2x9k4w8", "n1p3v6z5a"].join("");
  const DIGIT_ID = ["4242", "4242", "42"].join("");

  it.each([
    {
      name: "an id in a key",
      value: { notes: { [`seen ${HOST_ID}`]: 1, other: 2 } },
      expected: { notes: { [`seen ${label(HOST_ID)}`]: 1, other: 2 } },
    },
    {
      name: "an id in a key that two items repeat",
      value: [{ [`seen ${HOST_ID}`]: 1 }, { [`seen ${HOST_ID}`]: 2 }],
      expected: [{ [`seen ${label(HOST_ID)}`]: 1 }, { [`seen ${label(HOST_ID)}`]: 2 }],
    },
    {
      name: "two keys that scrub to one, keeping the last value at the first position",
      value: { [HOST_ID]: 1, between: 2, [label(HOST_ID)]: 3 },
      expected: { [label(HOST_ID)]: 3, between: 2 },
    },
    {
      name: "-0, Infinity, undefined and a Date beside a scrubbed id, read back as JSON",
      value: {
        url: `https://3000-${HOST_ID}.e2b.app`,
        numbers: [-0, Infinity, undefined],
        gone: undefined,
        at: new Date("2026-10-14T00:00:00.000Z"),
      },
      expected: {
        url: `https://3000-${label(HOST_ID)}.e2b.app`,
        numbers: [0, null, null],
        at: "2026-10-14T00:00:00.000Z",
      },
    },
    {
      name: "an id in a boxed string, which JSON.stringify writes as its text",
      value: { note: Object(`kill(${GUEST_ID}) returned true`) as unknown },
      expected: { note: `kill(${label(GUEST_ID)}) returned true` },
    },
  ])("rewrites $name", ({ value, expected }) => {
    const ids = [HOST_ID, GUEST_ID];
    expect(publicSandboxView(value, ids)).toStrictEqual(expected);
    expect(wholeTextView(value, ids)).toStrictEqual(expected);
  });

  it("returns the value itself when no token names an id", () => {
    const value = { numbers: [-0, Infinity], at: new Date(0), gone: undefined };
    expect(publicSandboxView(value, [HOST_ID])).toBe(value);
  });

  it.each([
    {
      name: "an id that spans two strings and the comma between them",
      value: ["abcdefgh", "ijklmnop"],
      ids: ['abcdefgh","ijklmnop'],
      expected: [label('abcdefgh","ijklmnop')],
    },
    {
      name: "two ids holding quotes that together cut one string out of two",
      value: ["xabc", "defy"],
      ids: ['abc"', '"def'],
      expected: [`x${label('abc"')},${label('"def')}y`],
    },
  ])("rewrites $name as the whole text did", ({ value, ids, expected }) => {
    expect(publicSandboxView(value, ids)).toStrictEqual(expected);
    expect(wholeTextView(value, ids)).toStrictEqual(expected);
  });

  it.each([
    ["an id written across a JSON escape", { text: `\n${ESCAPE_ID.slice(1)}` }, ESCAPE_ID],
    ["an id that spans two numbers", { list: [1, 2] }, "1,2"],
    ["an id inside a number", { at: Number(`1${DIGIT_ID}`) }, DIGIT_ID],
    ["an id inside the null written for an undefined array item", { list: [undefined] }, "ull"],
  ])("throws on %s, as the whole-text scrub did", (_name, value, id) => {
    expect(() => wholeTextView(value, [id])).toThrow(SyntaxError);
    expect(() => publicSandboxView(value, [id])).toThrow(SyntaxError);
  });

  it("agrees with it on generated values with ids in strings, keys, URLs and numbers", () => {
    const seen = { changed: 0, threw: 0, spanned: 0 };
    fc.assert(
      fc.property(viewCases(), ({ value, ids }) => {
        const expected = outcome(() => wholeTextView(value, ids));
        const actual = outcome(() => publicSandboxView(value, ids));
        expect(actual).toStrictEqual(expected);
        // Both return the value itself when nothing in it changed.
        if (typeof actual !== "string" && typeof expected !== "string")
          expect(actual.value === value).toBe(expected.value === value);
        if (typeof expected === "string") seen.threw += 1;
        else if (expected.text !== JSON.stringify(redactSandboxIds(value))) {
          seen.changed += 1;
          if (ids.some((one) => /[{}[\],:"\\]/.test(one))) seen.spanned += 1;
        }
      }),
      propertyParameters(),
    );
    // Both outcomes the scrub can have were reached, also for ids that can span two tokens, so
    // the comparison covered them.
    expect(seen.changed).toBeGreaterThan(20);
    expect(seen.threw).toBeGreaterThan(2);
    expect(seen.spanned).toBeGreaterThan(5);
  });
});

describe("publicSandboxView on values JSON.stringify converts", () => {
  const ids = [HOST_ID, GUEST_ID];
  const id = label(HOST_ID);
  const callable = Object.assign(() => 0, { toJSON: () => HOST_ID });
  const renamed = Object.assign(Object("safe") as object, { toString: () => HOST_ID });
  const flipped = Object.assign(Object(true) as object, { valueOf: () => false });
  const rawJSON = (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON;
  // An array from toJSON whose first read shrinks or grows it: JSON.stringify reads its length once.
  const resized = (resize: (array: unknown[]) => void) => ({
    toJSON: () => {
      const array: unknown[] = [HOST_ID, 42];
      Object.defineProperty(array, "0", {
        get: () => {
          resize(array);
          return HOST_ID;
        },
      });
      return array;
    },
  });

  it.each([
    { name: "a function's toJSON", value: { f: callable }, expected: { f: id } },
    { name: "a boxed string by its toString", value: { s: renamed }, expected: { s: id } },
    {
      name: "a boxed boolean by its own value",
      value: { x: HOST_ID, b: flipped },
      expected: { x: id, b: true },
    },
    {
      name: "a boxed string from another realm",
      value: { x: HOST_ID, s: vm.runInNewContext('new String("hello")') as unknown },
      expected: { x: id, s: "hello" },
    },
    {
      name: "an object on String.prototype that boxes nothing",
      value: { x: HOST_ID, v: Object.create(String.prototype) as unknown },
      expected: { x: id, v: {} },
    },
    {
      name: "raw JSON text",
      value: { x: HOST_ID, n: rawJSON("123") },
      expected: { x: id, n: 123 },
    },
    {
      name: "an array that shrinks while it is read",
      value: resized((array) => (array.length = 1)),
      expected: [id, null],
    },
    {
      name: "an array that grows while it is read",
      value: resized((array) => array.push(7)),
      expected: [id, 42],
    },
    {
      name: "a boxed bigint",
      value: { x: HOST_ID, b: Object(1n) as unknown },
      expected: "TypeError",
    },
  ])("converts $name as the whole text did", ({ value, expected }) => {
    const written =
      typeof expected === "string" ? expected : { value: expected, text: JSON.stringify(expected) };
    expect(outcome(() => publicSandboxView(value, ids))).toStrictEqual(written);
    expect(outcome(() => wholeTextView(value, ids))).toStrictEqual(written);
  });

  it("calls a bigint's toJSON with its key, as JSON.stringify does", () => {
    const prototype = BigInt.prototype as unknown as { toJSON?: (key: string) => string };
    prototype.toJSON = (key) => (key === "n" ? HOST_ID : "safe");
    try {
      const value = { n: 1n, m: 2n };
      const written = { value: { n: id, m: "safe" }, text: JSON.stringify({ n: id, m: "safe" }) };
      expect(outcome(() => publicSandboxView(value, ids))).toStrictEqual(written);
      expect(outcome(() => wholeTextView(value, ids))).toStrictEqual(written);
    } finally {
      delete prototype.toJSON;
    }
  });
});

describe("the sandbox id scrub with a 50,000-character id", () => {
  // V8 refuses to compile a RegExp of about 40,000 characters, so no single pattern can hold it.
  const LONG_ID = "a".repeat(50_000);

  it("labels it in text, bytes and values, and passes text without it through", () => {
    expect(scrubSandboxIds("safe", [LONG_ID])).toBe("safe");
    expect(scrubSandboxIds(`x${LONG_ID}y é`, [LONG_ID])).toBe(`x${label(LONG_ID)}y é`);
    expect(scrubSandboxIdBytes("trace.txt", Buffer.from(LONG_ID), [LONG_ID]).toString()).toBe(
      label(LONG_ID),
    );
    const value = { text: "safe", quoted: `kill ${LONG_ID}` };
    expect(publicSandboxView(value, [HOST_ID, LONG_ID])).toStrictEqual({
      text: "safe",
      quoted: `kill ${label(LONG_ID)}`,
    });
  });
});

const range = (characters: string): string[] => [...characters];
const ALPHANUMERIC = range("abcdefghijklmnopqrstuvwxyz0123456789");

/**
 * Ids drawn from E2B's shape, short ids that start like an escape's tail or hold characters JSON
 * or a RegExp escapes, ids holding `{}[],:` that can span two tokens of the whole text, and digit
 * ids a number can hold.
 */
function sandboxIds(): fc.Arbitrary<string[]> {
  const e2b = fc
    .string({ unit: fc.constantFrom(...ALPHANUMERIC), minLength: 19, maxLength: 19 })
    .map((rest) => `i${rest}`);
  const escaping = fc.string({
    unit: fc.constantFrom(
      ...range("nrtbfu0123abcdef-./*+?^$()| é😀{}[],:"),
      '"',
      "\\",
      "\n",
      "\u0001",
      "\ud800",
    ),
    minLength: 1,
    maxLength: 5,
  });
  const digits = fc.string({
    unit: fc.constantFrom(...range("0123456789")),
    minLength: 1,
    maxLength: 8,
  });
  // The end of one string, the JSON between two tokens, and the start of the next.
  const word = fc.string({ unit: fc.constantFrom(...range("abc1")), minLength: 1, maxLength: 3 });
  const spanning = fc
    .tuple(word, fc.constantFrom('","', '":"', '":', '",', ",", '"]', '"}'), word)
    .map((parts) => parts.join(""));
  return fc.uniqueArray(fc.oneof(e2b, e2b, escaping, digits, spanning), {
    minLength: 1,
    maxLength: 3,
  });
}

/**
 * A value whose strings, keys and numbers hold the ids whole, cut, split at JSON punctuation, next
 * to escapes and as labels.
 */
function viewCases(): fc.Arbitrary<{ value: unknown; ids: string[] }> {
  return sandboxIds().chain((ids) => {
    const id = fc.constantFrom(...ids);
    const segment = fc.oneof(
      id,
      id.map((one) => `https://6080-${one}.e2b.app/vnc.html`),
      fc.tuple(id, fc.integer({ min: 1, max: 3 })).map(([one, cut]) => one.slice(cut)),
      fc.tuple(id, fc.integer({ min: 1, max: 3 })).map(([one, cut]) => one.slice(0, -cut)),
      // The parts an id splits into at JSON punctuation, which adjacent tokens can hold.
      id.map((one) => one.split(/[{}[\],:"]/)[0]!),
      id.map((one) => one.split(/[{}[\],:"]/).at(-1)!),
      id.map(label),
      fc.constantFrom("\n", "\t", "\r", "\b", "\f", "\u0001", "\u001f", "\ud800", '"', "\\"),
      fc.constantFrom("open", "sandbox ", "null", "true", "1"),
    );
    const text = fc.array(segment, { maxLength: 4 }).map((parts) => parts.join(""));
    const key = fc.oneof(text, fc.constantFrom("sandboxId", "__proto__", "7", "10", "toJSON"));
    const digitIds = ids.filter((one) => /^\d+$/.test(one)).map(Number);
    const number = fc.oneof(
      fc.integer(),
      fc.double(),
      fc.constantFrom(-0, Infinity, -Infinity, NaN, ...digitIds),
    );
    const { value } = fc.letrec<{ value: unknown; array: unknown[]; object: object }>((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        text,
        number,
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.date({ min: new Date(0), max: new Date(4102444800000) }),
        id.map((one) => ({ sandboxId: one, providerResources: [{ id: one }] })),
        tie("array"),
        tie("object"),
      ),
      array: fc.array(tie("value"), { maxLength: 4 }),
      object: fc
        .array(fc.tuple(key, tie("value")), { maxLength: 4 })
        .map((entries) => Object.fromEntries(entries) as object),
    }));
    return value.map((generated) => ({ value: generated, ids }));
  });
}
