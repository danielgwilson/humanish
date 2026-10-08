import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { REDACTION_MARKERS, redactJsonLine, redactText } from "../../src/evidence/redaction.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

const LOCAL = REDACTION_MARKERS.localPath;
const RUNTIME = REDACTION_MARKERS.runtimePath;
const SECRET = REDACTION_MARKERS.secret;

const characters = (from: readonly string[], minLength: number, maxLength: number) =>
  fc.array(fc.constantFrom(...from), { minLength, maxLength }).map((chars) => chars.join(""));

describe("redactJsonLine", () => {
  it("keeps the text after a path that a line break in a string ends", () => {
    const line = JSON.stringify({ o: "cwd: /tmp/humanish-eval.k3f9qz\ncreated:\n  AGENTS.md\n" });
    expect(JSON.parse(redactJsonLine(line))).toEqual({
      o: `cwd: ${LOCAL}\ncreated:\n  AGENTS.md\n`,
    });
  });

  it("redacts a path that holds a backslash and an n whole, as redactText does", () => {
    const line = JSON.stringify({ o: "/tmp/a\\ncustomer.csv" });
    expect(redactJsonLine(line)).toBe(`{"o":"${LOCAL}"}`);
    expect(redactText(line)).toBe(`{"o":"${LOCAL}"}`);
  });

  it("redacts a path in a key", () => {
    const line = JSON.stringify({ "/home/someone/notes.txt": 1, ok: true });
    expect(redactJsonLine(line)).toBe(`{"${RUNTIME}":1,"ok":true}`);
  });

  it("keeps a credential name's hold on its value when a path covers the name", () => {
    for (const [key, value, expected] of [
      ["API_KEY", "abcd1234abcd1234", `{"API_KEY":"${SECRET}"}`],
      ["/tmp/dir/API_KEY", "abcd1234abcd1234", `{"${LOCAL}":"${SECRET}"}`],
      ["API_KEY", "ab/tmp/cdefghij12345", `{"API_KEY":"${SECRET}"}`],
    ]) {
      const line = JSON.stringify({ [key!]: value });
      expect(redactJsonLine(line), key).toBe(expected);
      expect(redactText(line), key).toBe(expected);
    }
  });

  it("reads JSON inside a string as redactText does, so a path there runs on through `\\n`", () => {
    const line = JSON.stringify({ o: JSON.stringify({ cwd: "/tmp/x\nfoo", ok: true }) });
    const inner = JSON.parse(JSON.parse(redactJsonLine(line)).o);
    expect(inner).toEqual({ cwd: LOCAL, ok: true });
    expect(JSON.parse(JSON.parse(redactText(line)).o)).toEqual(inner);
  });

  it("gives a line that is not JSON, or a cut record, exactly what redactText gives it", () => {
    const record = JSON.stringify({ o: "cwd: /tmp/x\ncreated:\n", API_KEY: "abcd1234abcd1234" });
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 60 }),
          fc.nat({ max: record.length - 1 }).map((end) => record.slice(0, end)),
          fc.constant("cwd: /tmp/x\\ncreated:"),
        ),
        (line) => {
          fc.pre(!parses(line));
          expect(redactJsonLine(line)).toBe(redactText(line));
        },
      ),
      propertyParameters(),
    );
  });
});

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Properties over JSON built from known parts, so each path and what follows it are known.

/** Characters that end a path in decoded text: whitespace, quotes, a backtick, `<`, `>`, `)`. */
const ENDINGS = [..."\t\n\u000b\f\r \"'`<>)", "\u00a0", "\u2028", "\u3000", "\ufeff"];
// Text outside a path: no `/`, so it starts no path, and no `q`, which only paths and credential
// values hold.
const PLAIN = [..."abcdefnrtux09:,.\\", ...ENDINGS, "é", "\u0001"];
// The rest of a path: backslashes before escape letters, `\u` text, non-ASCII and control
// characters, and nothing that ends a path.
const TAIL = [..."qqqnrtfbu0aAcCeE9.-,:(]{}/\\", "é", "😀", "\b", "\u0001", "\u2027"];
const NAME = [..."q0.-"];

interface Part {
  text: string;
  redacted: string;
}

const plain: fc.Arbitrary<Part> = characters(PLAIN, 1, 8).map((text) => ({
  text,
  redacted: text,
}));

/** A path and the character after it. A path keeps the backslashes it ends in after its marker. */
const path: fc.Arbitrary<Part> = fc
  .tuple(
    fc.oneof(
      fc
        .tuple(
          fc.constantFrom("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"),
          characters(TAIL, 0, 10),
        )
        .map(([start, rest]) => ({ text: start + rest, marker: LOCAL })),
      fc
        .tuple(
          fc.constantFrom(["/Users/", LOCAL] as const, ["/home/", RUNTIME] as const),
          characters(NAME, 1, 4),
          fc.option(characters(TAIL, 0, 10), { nil: undefined }),
        )
        .map(([[start, marker], name, rest]) => ({
          text: `${start}${name}${rest === undefined ? "" : `/${rest}`}`,
          marker,
        })),
    ),
    fc.constantFrom(...ENDINGS),
  )
  .map(([{ text, marker }, ending]) => ({
    text: text + ending,
    redacted: marker + (/\\+$/.exec(text)?.[0] ?? "") + ending,
  }));

const string = fc.array(fc.oneof(plain, path), { minLength: 1, maxLength: 5 }).map((parts) => ({
  text: parts.map((part) => part.text).join(""),
  redacted: parts.map((part) => part.redacted).join(""),
}));

/** A JSON string that writes `\u` escapes for quotes, `<`, `>`, `&`, a backtick, `)`, control and
 *  non-ASCII characters, as some encoders do. */
const escapedString = (value: string): string =>
  `"${Array.from(value, (character) =>
    character === "\\"
      ? "\\\\"
      : /[\x20-\x7e]/.test(character) && !/["'<>&`)]/.test(character)
        ? character
        : Array.from(
            { length: character.length },
            (_, at) => `\\u${character.charCodeAt(at).toString(16).padStart(4, "0")}`,
          ).join(""),
  ).join("")}"`;

/** JSON with every string, keys included, written by escapedString. */
const escapingAll = (value: unknown): string =>
  typeof value === "string"
    ? escapedString(value)
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .map(([key, child]) => `${escapedString(key)}:${escapingAll(child)}`)
          .join(",")}}`
      : JSON.stringify(value);

describe("redactJsonLine on Codex lines built from known parts", () => {
  it("redacts each string as its decoded text, keys included, and keeps everything else", () => {
    fc.assert(
      fc.property(
        string,
        string,
        string,
        fc.constantFrom(JSON.stringify, escapingAll),
        (command, output, key, encode) => {
          const line = encode({
            type: "item.completed",
            item: { id: "item_1", type: "command_execution", command: command.text },
            fields: { [key.text]: output.text },
          });
          expect(JSON.parse(redactJsonLine(line))).toEqual({
            type: "item.completed",
            item: { id: "item_1", type: "command_execution", command: command.redacted },
            fields: { [key.redacted]: output.redacted },
          });
        },
      ),
      propertyParameters(),
    );
  });

  // A `q` is only in a path whose characters redactText hides, or in a credential value it hides
  // by its name. A `q` in the output is something main hid and this line shows.
  it("hides everything redactText hides when no path holds a line break, tab or quote", () => {
    const sentinelPath = fc
      .tuple(
        fc.constantFrom("/tmp/q", "/home/q/", "/Users/q0/", "/var/folders/"),
        characters(TAIL, 0, 12),
      )
      .map(([start, rest]) => start + rest);
    const credential = fc.tuple(
      fc.constantFrom("API_KEY", "GITHUB_TOKEN", "/tmp/qdir/API_KEY", "/home/q/SECRET"),
      fc.constantFrom("q1qqqqqqqqqqqqqq", "qq/tmp/q1qqqqqqqqqqqq", "q9q/home/q/qqqqqqqqq"),
    );
    const prose = fc
      .array(fc.oneof(characters(PLAIN, 1, 6), sentinelPath), { minLength: 1, maxLength: 5 })
      .map((parts) => parts.join(" "));
    fc.assert(
      fc.property(
        prose,
        prose,
        credential,
        fc.constantFrom(JSON.stringify, escapingAll),
        (text, key, [name, value], encode) => {
          const line = encode({ text, [key]: "x", [name]: value });
          expect(redactText(line)).not.toContain("q");
          expect(redactJsonLine(line)).not.toContain("q");
        },
      ),
      propertyParameters(),
    );
  });
});

// ---------------------------------------------------------------------------

describe("the backslashes a redacted path ends in", () => {
  // They may escape the closing quote of a JSON string, so redaction keeps them. The expression
  // main used to find them is the reference.
  const trailingBackslashes = (text: string): string => text.match(/\\+$/)?.[0] ?? "";

  it("are the ones the earlier expression found", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ["/tmp/", LOCAL] as const,
          ["/home/someone/", RUNTIME] as const,
          ["C:\\Users\\someone\\", LOCAL] as const,
        ),
        characters([..."\\an."], 0, 40),
        fc.constantFrom("", " ", '"', "\n", ")"),
        characters([..."\\an "], 0, 10),
        ([start, marker], tail, ending, rest) => {
          const after = ending === "" ? "" : ending + rest;
          expect(redactText(start + tail + after)).toBe(
            marker + trailingBackslashes(start + tail) + after,
          );
        },
      ),
      propertyParameters(),
    );
  });

  /** Milliseconds for the fastest of five redactions. */
  const fastest = (text: string): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();
      redactText(text);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  // The expression retried the run of backslashes from each of its characters when a character
  // followed it: 40,000 backslashes took 1.4 s. Linear takes about four times as long for four
  // times the run; the 20 ms floor keeps timer noise out of the ratio.
  it("are found in time linear in the run of backslashes", () => {
    const text = (count: number): string => `/tmp/${"\\".repeat(count)}x`;
    expect(redactText(text(16_384))).toBe(LOCAL);
    const ratio = fastest(text(65_536)) / Math.max(20, fastest(text(16_384)));
    expect(ratio).toBeLessThan(10);
  });
});
