// containsSensitiveJson scans one element of an array at a time and must answer as the scan of the
// whole document does. Two patterns can match across the text between elements: a URL's user info
// runs over quotes and braces up to an `@`, and a credential variable's unquoted value runs over
// closing brackets. Each case states the answer and checks the whole-document scan agrees.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

// The detectors, recorded, so a test can read every text the scan hands them.
vi.mock("../../src/evidence/redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/evidence/redaction.js")>();
  return {
    ...actual,
    containsSensitive: vi.fn(actual.containsSensitive),
    containsSandboxUrl: vi.fn(actual.containsSandboxUrl),
  };
});

import { containsSandboxUrl, containsSensitive } from "../../src/evidence/redaction.js";
import { containsSensitiveJson } from "../../src/evidence/sensitive-json.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

// Concatenated so this file never holds a secret-shaped literal.
const KEY = "sk-" + "syntheticvalue1234567890abcdef";

const CASES: Array<[string, Record<string, unknown>, boolean]> = [
  ["clean elements", { streams: [{ text: "saved" }, { text: "opened" }] }, false],
  ["a key in a middle element", { streams: [{ a: 1 }, { text: KEY }, { b: 2 }] }, true],
  ["a key before the array", { persona: KEY, streams: [{ a: 1 }, { b: 2 }] }, true],
  ["a key after the array", { streams: [{ a: 1 }, { b: 2 }], events: [{ message: KEY }] }, true],
  [
    "URL user info from one element into the next",
    { streams: [{ url: "https://host" }, { contact: "ops@e2b-host" }] },
    true,
  ],
  [
    "URL user info across an element with no slash or space",
    { streams: [{ url: "https://host" }, { n: 1 }, { contact: "ops@e2b-host" }] },
    true,
  ],
  [
    "URL user info stopped by a slash in the element between",
    { streams: [{ url: "https://host" }, { path: "a/b" }, { contact: "ops@e2b-host" }] },
    false,
  ],
  [
    "URL user info stopped by a space in the element between",
    { streams: [{ url: "https://host" }, { text: "a b" }, { contact: "ops@e2b-host" }] },
    false,
  ],
  [
    "URL user info from before the array into its first element",
    { url: "https://host", streams: [{ contact: "ops@e2b-host" }] },
    true,
  ],
  [
    "URL user info from the last element past the array",
    { streams: [{ id: "a" }, { url: "https://host" }], contact: "ops@e2b-host" },
    true,
  ],
  [
    // The value `[[[[-1e+21]]]]` is 14 characters; with the element's `}` and the array's `]` it
    // reaches the 16 a credential value needs.
    "a credential value running past the last element",
    { streams: [{ id: "a" }, { TOKEN: [[[[-1e21]]]] }], events: [] },
    true,
  ],
  [
    "a credential value stopped by the comma after an element",
    { streams: [{ TOKEN: [[[[-1e21]]]] }, { id: "a" }] },
    false,
  ],
  ["an empty array", { url: "https://host", streams: [], contact: "ops@e2b-host" }, true],
  [
    "URL user info across an element with an @ and no slash or space",
    { streams: [{ url: "https://host" }, { n: "a@b" }, { contact: "ops@e2b-host" }] },
    true,
  ],
  [
    "a host after an @ stopped by its string's closing quote",
    { streams: [{ url: "https://host" }, { n: "a@e2" }, { contact: "b.dev" }] },
    false,
  ],
];

// Shapes JSON.parse never makes, which JSON.stringify writes differently from their own keys.
const UNPARSED: Array<[string, Record<string, unknown>]> = [
  // JSON.stringify calls an element's toJSON with its index, and with "" on the element alone.
  [
    "an element whose toJSON reads its index",
    { streams: [{ toJSON: (index: string) => ({ text: index === "0" ? KEY : "clean" }) }] },
  ],
  [
    "an array with toJSON",
    { streams: Object.assign([{ text: "clean" }], { toJSON: () => [{ text: KEY }] }) },
  ],
  [
    "a document with an inherited toJSON",
    Object.assign(Object.create({ toJSON: () => ({ text: KEY }) }) as object, {
      streams: [{ text: "clean" }],
    }),
  ],
  ["a boxed string element", { streams: [Object(KEY) as object] }],
  // Array.prototype.every skips a hole, and JSON.stringify writes it as null.
  ["a sparse array", { persona: KEY, streams: Array<unknown>(2) }],
];

// Pieces of the shapes above: schemes, user info, hosts, the characters that stop or carry a match,
// and the public E2B pages the sandbox URL pattern leaves alone.
const FRAGMENTS = [
  "https://",
  "http:\\/\\/",
  "HTTPS://",
  "host",
  "ops@",
  "@",
  "e2b",
  "E2B",
  ".dev",
  "docs.e2b.dev",
  "e2b.dev/dashboard",
  "/",
  " ",
  "\n",
  "TOKEN=",
  "1",
  "x",
  ")",
  '"',
  "'",
  "<",
  "\\",
  "},{",
  "]",
];
const text = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 6 })
  .map((parts) => parts.join(""));
const { json } = fc.letrec((tie) => ({
  json: fc.oneof(
    { depthSize: "small" },
    text,
    fc.constantFrom(1, -1e21, null, true),
    fc.array(tie("json"), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("a", "TOKEN"), tie("json"), { maxKeys: 2 }),
  ),
}));
const element = fc.dictionary(fc.constantFrom("id", "TOKEN", "url", "contact"), json, {
  maxKeys: 3,
});
const documents = fc
  .tuple(
    fc.dictionary(fc.constantFrom("url", "TOKEN"), json, { maxKeys: 2 }),
    fc.array(element, { maxLength: 5 }),
    fc.dictionary(fc.constantFrom("contact", "events"), json, { maxKeys: 2 }),
  )
  .map(([before, streams, after]) => ({ ...before, streams, ...after }));

describe("containsSensitiveJson", () => {
  it.each(CASES)("%s", (_name, value, sensitive) => {
    expect([
      containsSensitiveJson(value, "streams"),
      containsSensitive(JSON.stringify(value)),
    ]).toEqual([sensitive, sensitive]);
  });

  it.each(UNPARSED)("scans %s as the whole text", (_name, value) => {
    expect([
      containsSensitiveJson(value, "streams"),
      containsSensitive(JSON.stringify(value)),
    ]).toEqual([true, true]);
  });

  it("hands no detector a text that holds two elements", () => {
    // After a scheme, elements with no slash or space let a URL's user info run on across them.
    const texts = ["first-part", "second-part", "third-part"];
    const value = { streams: [{ url: "https://host" }, ...texts.map((t) => ({ t }))] };
    const detectors = [vi.mocked(containsSensitive), vi.mocked(containsSandboxUrl)];
    for (const detector of detectors) detector.mockClear();
    expect(containsSensitiveJson(value, "streams")).toBe(false);
    const joined = detectors
      .flatMap((detector) => detector.mock.calls.map(([scanned]) => scanned))
      .filter((scanned) => texts.filter((part) => scanned.includes(part)).length > 1);
    expect(joined).toEqual([]);
  });

  it("answers as the whole-document scan does on generated documents", () => {
    fc.assert(
      fc.property(documents, (value) => {
        expect(containsSensitiveJson(value, "streams")).toBe(
          containsSensitive(JSON.stringify(value)),
        );
      }),
      propertyParameters(),
    );
  });
});
