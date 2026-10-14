// containsSensitiveJson scans one element of an array at a time and must answer as the scan of the
// whole document does. Two patterns can match across the text between elements: a URL's user info
// runs over quotes and braces up to an `@`, and a credential variable's unquoted value runs over
// closing brackets. Each case states the answer and checks the whole-document scan agrees.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { containsSensitive } from "../../src/evidence/redaction.js";
import { containsSensitiveJson } from "../../src/evidence/sensitive-json.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

// Concatenated so this file never holds a secret-shaped literal.
const KEY = "sk-" + "syntheticvalue1234567890abcdef";

const CASES: Array<[string, Record<string, unknown>, boolean]> = [
  ["clean elements", { streams: [{ text: "saved" }, { text: "opened" }] }, false],
  ["a key in a middle element", { streams: [{ a: 1 }, { text: KEY }, { b: 2 }] }, true],
  [
    "URL user info from one element into the next",
    { streams: [{ url: "https://host" }, { contact: "ops@e2b.dev" }] },
    true,
  ],
  [
    "URL user info across an element with no slash or space",
    { streams: [{ url: "https://host" }, { n: 1 }, { contact: "ops@e2b.dev" }] },
    true,
  ],
  [
    "URL user info stopped by a slash in the element between",
    { streams: [{ url: "https://host" }, { path: "a/b" }, { contact: "ops@e2b.dev" }] },
    false,
  ],
  [
    "URL user info stopped by a space in the element between",
    { streams: [{ url: "https://host" }, { text: "a b" }, { contact: "ops@e2b.dev" }] },
    false,
  ],
  [
    "URL user info from before the array into its first element",
    { url: "https://host", streams: [{ contact: "ops@e2b.dev" }] },
    true,
  ],
  [
    "URL user info from the last element past the array",
    { streams: [{ id: "a" }, { url: "https://host" }], contact: "ops@e2b.dev" },
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
  ["an empty array", { url: "https://host", streams: [], contact: "ops@e2b.dev" }, true],
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
