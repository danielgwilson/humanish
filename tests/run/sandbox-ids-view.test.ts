import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { redactSandboxIds, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { publicSandboxView } from "../../src/run/sandbox-ids.js";
import { isRecord } from "../../src/run/type-guards.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

// publicSandboxView on a run bundle: with E2B ids, the shell and each participant's stream are
// scrubbed on their own, so no string holds two participants' items and a hosted run whose traces
// together pass V8's longest string still writes run.json. For any ids, the result's JSON text
// must stay what the scrub of the whole JSON text returned, which wholeTextView below keeps as
// the reference, and so must the value wherever a label went in.

// Shaped like E2B ids and built at run time, so this file holds none at a sandbox-id key.
const HOST_ID = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const GUEST_ID = ["i", "z5a8c3e1g7", "k2m4o6q9b"].join("");
const label = (id: string): string => `[redacted-sandbox-id ${sandboxIdDigest(id)}]`;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The scrub as it was before it worked one stream at a time: the whole value's JSON text, each id
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

/** An array of `item` after a hole, which JSON.stringify writes as null. */
function afterHole(item: unknown): unknown[] {
  const items: unknown[] = [];
  items[1] = item;
  return items;
}

/** `items` with an own iterator that yields nothing, which JSON.stringify never calls. */
function emptyIterator(items: unknown[]): unknown[] {
  return Object.assign(items, { [Symbol.iterator]: function* () {} });
}

describe("publicSandboxView on a run bundle", () => {
  it("serializes no two participants' items in one string", () => {
    const bundle = {
      ...twoParticipantBundle(),
      events: [{ id: "event-1", message: `kill(${HOST_ID}) returned true` }],
    };
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    const view = publicSandboxView(bundle, [HOST_ID, GUEST_ID]);
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
    expect(view.events[0]!.message).toBe(`kill(${label(HOST_ID)}) returned true`);
  });

  it.each([
    {
      name: "an id in a URL in the last stream",
      value: {
        runId: "r",
        streams: [{ text: "safe" }, { url: `https://6080-${GUEST_ID}.e2b.app` }],
      },
      ids: [HOST_ID, GUEST_ID],
      expected: {
        runId: "r",
        streams: [{ text: "safe" }, { url: `https://6080-${label(GUEST_ID)}.e2b.app` }],
      },
    },
    {
      name: "an id in the shell and its events, before and after the streams",
      value: {
        note: `seen ${HOST_ID}`,
        streams: [{ text: "safe" }],
        events: [{ message: `kill(${GUEST_ID})` }],
      },
      ids: [HOST_ID, GUEST_ID],
      expected: {
        note: `seen ${label(HOST_ID)}`,
        streams: [{ text: "safe" }],
        events: [{ message: `kill(${label(GUEST_ID)})` }],
      },
    },
    {
      name: "an id in a key that two streams repeat",
      value: { streams: [{ [`seen ${HOST_ID}`]: 1 }, { [`seen ${HOST_ID}`]: 2 }] },
      ids: [HOST_ID],
      expected: { streams: [{ [`seen ${label(HOST_ID)}`]: 1 }, { [`seen ${label(HOST_ID)}`]: 2 }] },
    },
    {
      name: "two keys of a stream that scrub to one, keeping the last value at the first position",
      value: { streams: [{ [HOST_ID]: 1, between: 2, [label(HOST_ID)]: 3 }] },
      ids: [HOST_ID],
      expected: { streams: [{ [label(HOST_ID)]: 3, between: 2 }] },
    },
    {
      name: "two shell keys that scrub to one, around the streams",
      value: { [HOST_ID]: 1, streams: [{ url: HOST_ID }], [label(HOST_ID)]: 3 },
      ids: [HOST_ID],
      expected: { [label(HOST_ID)]: 3, streams: [{ url: label(HOST_ID) }] },
    },
    {
      name: "-0, Infinity, undefined and a Date in a stream that names an id, read back as JSON",
      value: {
        streams: [
          {
            url: `https://3000-${HOST_ID}.e2b.app`,
            numbers: [-0, Infinity, undefined],
            gone: undefined,
            at: new Date("2026-10-14T00:00:00.000Z"),
          },
        ],
      },
      ids: [HOST_ID],
      expected: {
        streams: [
          {
            url: `https://3000-${label(HOST_ID)}.e2b.app`,
            numbers: [0, null, null],
            at: "2026-10-14T00:00:00.000Z",
          },
        ],
      },
    },
    {
      name: "an id that spans two streams and the text between them",
      value: { runId: "r", streams: [{ note: "abc" }, { note: "def" }] },
      ids: ['abc"},{"note":"def'],
      expected: { runId: "r", streams: [{ note: label('abc"},{"note":"def') }] },
    },
    {
      name: "an id inside the key streams",
      value: { runId: "r", streams: [{ note: "safe" }] },
      ids: ["reams"],
      expected: { runId: "r", [`st${label("reams")}`]: [{ note: "safe" }] },
    },
    {
      name: "a stream whose toJSON reads its index, which it gets only inside the bundle",
      value: { streams: [{ toJSON: (key: string) => ({ note: key === "0" ? HOST_ID : "safe" }) }] },
      ids: [HOST_ID],
      expected: { streams: [{ note: label(HOST_ID) }] },
    },
    {
      name: "streams with a hole, which the whole text writes as null",
      value: { streams: afterHole({ url: HOST_ID }) },
      ids: [HOST_ID],
      expected: { streams: [null, { url: label(HOST_ID) }] },
    },
    {
      name: "a bundle that is a boxed string, which JSON.stringify writes as its text",
      value: Object.assign(Object(`seen ${HOST_ID}`) as object, { streams: [{ url: HOST_ID }] }),
      ids: [HOST_ID],
      expected: `seen ${label(HOST_ID)}`,
    },
    {
      name: "streams whose own iterator yields nothing, which JSON.stringify reads by index",
      value: { streams: emptyIterator([{ url: `https://6080-${HOST_ID}.e2b.app` }]) },
      ids: [HOST_ID],
      expected: { streams: [{ url: `https://6080-${label(HOST_ID)}.e2b.app` }] },
    },
  ])("rewrites $name as the whole text did", ({ value, ids, expected }) => {
    expect(publicSandboxView(value, ids)).toStrictEqual(expected);
    expect(wholeTextView(value, ids)).toStrictEqual(expected);
  });

  it("returns the bundle itself when no stream and no shell member names an id", () => {
    const value = { runId: "r", streams: [{ at: new Date(0) }, { gone: undefined }] };
    expect(publicSandboxView(value, [HOST_ID])).toBe(value);
  });

  it("leaves out a streams member that JSON.stringify leaves out", () => {
    const value = { runId: "r" };
    Object.defineProperty(value, "streams", { value: [{ url: HOST_ID }], enumerable: false });
    expect(JSON.stringify(publicSandboxView(value, [HOST_ID]))).toBe('{"runId":"r"}');
    expect(JSON.stringify(wholeTextView(value, [HOST_ID]))).toBe('{"runId":"r"}');
  });

  it("throws on an id inside a number in a stream, as the whole-text scrub did", () => {
    const value = { streams: [{ text: "safe" }, { at: 1424242424242 }] };
    expect(() => wholeTextView(value, ["4242424242"])).toThrow(SyntaxError);
    expect(() => publicSandboxView(value, ["4242424242"])).toThrow(SyntaxError);
  });
});

describe("publicSandboxView on a run bundle once a label goes in", () => {
  it("reads a stream that names no id back as JSON once another stream names one", () => {
    const quiet = { at: new Date("2026-10-14T00:00:00.000Z"), gone: undefined };
    const value = { streams: [quiet, { url: HOST_ID }] };
    const expected = { streams: [{ at: "2026-10-14T00:00:00.000Z" }, { url: label(HOST_ID) }] };
    expect(publicSandboxView(value, [HOST_ID])).toStrictEqual(expected);
    expect(wholeTextView(value, [HOST_ID])).toStrictEqual(expected);
  });

  it("returns a view that reads nothing of the input", () => {
    // A getter and a toJSON that name the sandbox once the view has been returned.
    let returned = false;
    const late = (): string => (returned ? HOST_ID : "safe");
    const value = {
      get note() {
        return late();
      },
      streams: [{ value: { toJSON: late } }, { url: HOST_ID }],
    };
    const view = publicSandboxView(value, [HOST_ID]);
    returned = true;
    expect(view).toStrictEqual({
      note: "safe",
      streams: [{ value: "safe" }, { url: label(HOST_ID) }],
    });
  });

  it("calls each toJSON in the order the whole text does", () => {
    // A toJSON can read state an earlier one set, so the order shows in the output.
    const called: string[] = [];
    const mark = (name: string) => ({
      toJSON: () => {
        called.push(name);
        return name;
      },
    });
    const value = {
      first: mark("first"),
      streams: [{ a: mark("a") }, { b: mark("b"), url: HOST_ID }],
      last: mark("last"),
    };
    publicSandboxView(value, [HOST_ID]);
    expect(called).toEqual(["first", "a", "b", "last"]);
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

  it("returns the value itself when nothing in it names an id", () => {
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

  it("agrees with it on generated values and bundles with ids in strings, keys, URLs and numbers", () => {
    const seen = { changed: 0, threw: 0, spanned: 0, streamwise: 0 };
    fc.assert(
      fc.property(viewCases(), ({ value, ids }) => {
        const expected = outcome(() => wholeTextView(value, ids));
        const actual = outcome(() => publicSandboxView(value, ids));
        expect(actual).toStrictEqual(expected);
        // Both return the value itself when nothing in it changed.
        if (typeof expected !== "string" && typeof actual !== "string")
          expect(actual.value === value).toBe(expected.value === value);
        if (typeof expected === "string") seen.threw += 1;
        else if (expected.text !== JSON.stringify(redactSandboxIds(value))) {
          seen.changed += 1;
          if (ids.some((one) => /[{}[\],:"\\]/.test(one))) seen.spanned += 1;
          else if (
            !ids.some((one) => "streams".includes(one)) &&
            isRecord(value) &&
            Array.isArray(value.streams) &&
            value.streams.length > 1
          )
            seen.streamwise += 1;
        }
      }),
      propertyParameters(),
    );
    // Both outcomes the scrub can have were reached, for ids that can span two tokens and for
    // bundles of two or more streams with ids that cannot, so the comparison covered them.
    expect(seen.changed).toBeGreaterThan(20);
    expect(seen.threw).toBeGreaterThan(2);
    expect(seen.spanned).toBeGreaterThan(5);
    expect(seen.streamwise).toBeGreaterThan(5);
  });
});

const range = (characters: string): string[] => [...characters];
const ALPHANUMERIC = range("abcdefghijklmnopqrstuvwxyz0123456789");

/**
 * Ids drawn from E2B's shape, short ids that start like an escape's tail or hold characters JSON
 * escapes, ids holding `{}[],:` that can span two tokens of the whole text, digit ids a number can
 * hold, and parts of the key `streams`.
 */
function sandboxIds(): fc.Arbitrary<string[]> {
  const e2b = fc
    .string({ unit: fc.constantFrom(...ALPHANUMERIC), minLength: 19, maxLength: 19 })
    .map((rest) => `i${rest}`);
  const escaping = fc.string({
    unit: fc.constantFrom(
      ...range("nrtbfu0123abcdef-./ é😀{}[],:"),
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
    .tuple(word, fc.constantFrom('","', '":"', '":', '",', ",", '"]', '"}', '"},{"'), word)
    .map((parts) => parts.join(""));
  const streamsKey = fc.constantFrom("streams", "tream", "ams");
  return fc.uniqueArray(fc.oneof(e2b, e2b, e2b, escaping, digits, spanning, streamsKey), {
    minLength: 1,
    maxLength: 3,
  });
}

/**
 * A value whose strings, keys and numbers hold the ids whole, cut, split at JSON punctuation, next
 * to escapes and as labels, or a bundle of such members around a `streams` array. Most streams
 * are plain objects; a hole, a stream that is not one, a stream with a toJSON that reads its index,
 * or streams with an own iterator is mixed in.
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
    const { value, object } = fc.letrec<{ value: unknown; array: unknown[]; object: object }>(
      (tie) => ({
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
      }),
    );
    const stream = fc.oneof(
      { weight: 6, arbitrary: object },
      { weight: 1, arbitrary: value },
      { weight: 1, arbitrary: text.map((note) => ({ toJSON: (at: string) => ({ at, note }) })) },
    );
    const streams = fc.oneof(
      { weight: 5, arbitrary: fc.array(stream, { maxLength: 4 }) },
      {
        weight: 1,
        arbitrary: fc.array(stream, { minLength: 2, maxLength: 4 }).map((list) =>
          list.reduce<unknown[]>((holed, item, at) => {
            if (at > 0) holed[at] = item;
            return holed;
          }, []),
        ),
      },
      { weight: 1, arbitrary: fc.array(stream, { minLength: 1, maxLength: 4 }).map(emptyIterator) },
    );
    const members = fc.array(fc.tuple(key, value), { maxLength: 3 });
    const bundle = fc
      .tuple(members, streams, members)
      .map(
        ([before, list, after]) =>
          Object.fromEntries([...before, ["streams", list], ...after]) as object,
      );
    return fc.oneof(value, bundle).map((generated) => ({ value: generated, ids }));
  });
}
