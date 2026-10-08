import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  REDACTION_MARKERS,
  containsSensitive,
  redactText,
  redactToSecretLabel,
} from "../../src/evidence/redaction.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

// A terminal transcript is JSON lines, so a line break after a path reaches redaction as the two
// characters `\n`. A path ends there as it would at the decoded character, and an escaped
// backslash (`\\`) stays part of the path.

const LOCAL = REDACTION_MARKERS.localPath;
const RUNTIME = REDACTION_MARKERS.runtimePath;

/** A Codex `item.completed` line for a command whose output is `output`. */
const commandLine = (id: string, command: string, output: string): string =>
  JSON.stringify({
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command,
      aggregated_output: output,
      exit_code: 0,
      status: "completed",
    },
  });

/** The command output a redacted Codex line decodes to. */
const outputOf = (line: string): unknown => JSON.parse(line).item.aggregated_output;

describe("a path in a JSON-encoded terminal transcript", () => {
  // Shapes from terminal-2026-10-08T19-37-41-516Z-d85572b8 item_1 and item_8,
  // terminal-2026-10-08T19-50-16-019Z-c04b55bf item_7 and terminal-2026-10-08T19-38-20-124Z-b33029a8
  // item_5, with the paths before redaction written back in.
  it("keeps the line break and the header after `humanish init`'s cwd", () => {
    const line = commandLine(
      "item_8",
      "/bin/bash -lc 'npx humanish init --yes'",
      "humanish init applied\ncwd: /home/user/humanish-eval.k3f9qz\ncreated:\n  AGENTS.md\n  humanish/README.md\n",
    );
    expect(outputOf(redactText(line))).toBe(
      `humanish init applied\ncwd: ${RUNTIME}\ncreated:\n  AGENTS.md\n  humanish/README.md\n`,
    );
  });

  it("keeps the line break that ends mktemp's output", () => {
    const line = commandLine(
      "item_1",
      "/bin/bash -lc 'mktemp -d -p /home/user humanish-eval.XXXXXX'",
      "/home/user/humanish-eval.k3f9qz\n",
    );
    const redacted = JSON.parse(redactText(line));
    expect(redacted.item.command).toBe(
      `/bin/bash -lc 'mktemp -d -p ${RUNTIME} humanish-eval.XXXXXX'`,
    );
    expect(redacted.item.aggregated_output).toBe(`${RUNTIME}\n`);
  });

  it("keeps doctor's next row after a path", () => {
    const line = commandLine(
      "item_7",
      "/bin/bash -lc 'npx humanish doctor'",
      "- ok claude participant transcripts: no transcript from an earlier Claude Code participant under /home/user/.claude/projects\n- ok key OPENAI_API_KEY: not required for the selected participant route\n",
    );
    expect(outputOf(redactText(line))).toBe(
      `- ok claude participant transcripts: no transcript from an earlier Claude Code participant under ${RUNTIME}\n- ok key OPENAI_API_KEY: not required for the selected participant route\n`,
    );
  });

  it("keeps the blank line and the opening brace after npm init's file name", () => {
    const line = commandLine(
      "item_5",
      "/bin/bash -lc 'npm init -y'",
      'Wrote to /tmp/humanish-eval.5nt7xb/package.json:\n\n{\n  "name": "humanish-eval.5nt7xb",\n  "version": "1.0.0"\n}\n',
    );
    // The colon is part of the path, as it is in the decoded text.
    expect(outputOf(redactText(line))).toBe(
      `Wrote to ${LOCAL}\n\n{\n  "name": "humanish-eval.5nt7xb",\n  "version": "1.0.0"\n}\n`,
    );
  });

  it("ends at an escaped tab, carriage return or form feed as at the decoded character", () => {
    for (const [ending, label] of [
      ["\t", "tab"],
      ["\r", "carriage return"],
      ["\f", "form feed"],
    ] as const) {
      const redacted = JSON.parse(redactText(JSON.stringify({ o: `/tmp/a${ending}b` })));
      expect(redacted.o, label).toBe(`${LOCAL}${ending}b`);
    }
  });

  it("ends at a \\u escape of a character that ends a path, in either case", () => {
    for (const escape of [
      "\\u000a",
      "\\u0020",
      "\\u003c",
      "\\u003E",
      "\\u0022",
      "\\u2028",
      "\\uFEFF",
    ]) {
      const text = `{"o":"/tmp/a${escape}b"}`;
      expect(JSON.parse(redactText(text)).o, escape).toBe(`${LOCAL}${JSON.parse(`"${escape}"`)}b`);
    }
  });

  it("keeps an escaped backslash and every other escape inside the path", () => {
    for (const rest of ["\\nested", "\\\\more", "\bx", "\u0001x", "é", "/x", "\\"]) {
      const text = JSON.stringify({ o: `/tmp/dir${rest}`, ok: true });
      const redacted = JSON.parse(redactText(text));
      expect(redacted.ok, JSON.stringify(rest)).toBe(true);
      expect(redacted.o, JSON.stringify(rest)).toBe(`${LOCAL}${/\\+$/.exec(rest)?.[0] ?? ""}`);
    }
  });

  it("redacts a path in raw text through a backslash that starts no ending escape", () => {
    for (const path of ["/tmp/a\\bc", "/tmp/a\\\\nb", "/tmp/a\\/b", "/home/user/x\\u00e9y"]) {
      expect(redactText(`saw ${path} here`), path).toMatch(
        /^saw \[REDACTED_(?:LOCAL|RUNTIME)_PATH\] here$/,
      );
    }
  });

  it("redacts a path of several megabytes of escapes", () => {
    // A path tail written as one regex with alternatives overflowed V8's stack on this input.
    const output = redactText(`{"o":"/tmp/${"a\\b".repeat(3_000_000)}\\nnext"}`);
    expect(JSON.parse(output).o).toBe(`${LOCAL}\nnext`);
  });

  it("leaves a Windows profile path's backslash separators to that pattern", () => {
    expect(redactText("C:\\Users\\someone\\notes\\todo.txt done")).toBe(`${LOCAL} done`);
    expect(redactText(JSON.stringify({ o: "C:\\Users\\someone\\notes\\todo.txt" }))).toBe(
      `{"o":"${LOCAL}"}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The property: text built from known parts, so each path and what follows it are known.

/** Characters that end a path: whitespace, quotes, a backtick, `<`, `>` and `)`. */
const ENDINGS = [
  ..."\t\n\u000b\f\r \"'`<>)",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2005",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
];
// Text outside a path: no `/`, so it starts no path, and no `q`, which only paths hold.
const PLAIN = [..."abcdefnrtux09:,\\", ...ENDINGS, "é", "\u0001"];
// The rest of a path after its start: escape letters, hex digits, backslashes and non-ASCII, and no
// character that ends a path. Every `q` is path content, so a `q` in the output is a leak.
const TAIL = [
  ..."qqqnrtfbuaAcCeE09.-,:(]{}/\\",
  "é",
  "€",
  "😀",
  "\b",
  "\u0001",
  "\u2027",
  "\u007f",
];
const NAME = [..."q0.-"];

interface Segment {
  /** The text as written. */
  text: string;
  /** What the decoded output holds in its place. */
  redacted: string;
}

const characters = (from: readonly string[], minLength: number, maxLength: number) =>
  fc.array(fc.constantFrom(...from), { minLength, maxLength }).map((chars) => chars.join(""));

const plain: fc.Arbitrary<Segment> = characters(PLAIN, 1, 8).map((text) => ({
  text,
  redacted: text,
}));

/** A path and the character after it. A path's trailing backslashes stay after its marker. */
function pathSegment(tail: fc.Arbitrary<string>): fc.Arbitrary<Segment> {
  const keepsBackslashes = (path: string): string => /\\+$/.exec(path)?.[0] ?? "";
  const underTemp = fc
    .tuple(
      fc.constantFrom("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"),
      tail,
    )
    .map(([start, rest]) => ({ path: start + rest, marker: LOCAL }));
  const underHome = fc
    .tuple(
      fc.constantFrom(["/Users/", LOCAL] as const, ["/home/", RUNTIME] as const),
      characters(NAME, 1, 4),
      fc.option(tail, { nil: undefined }),
    )
    .map(([[start, marker], name, rest]) => ({
      path: `${start}${name}${rest === undefined ? "" : `/${rest}`}`,
      marker,
    }));
  return fc
    .tuple(fc.oneof(underTemp, underHome), fc.constantFrom(...ENDINGS))
    .map(([{ path, marker }, ending]) => ({
      text: path + ending,
      redacted: marker + keepsBackslashes(path) + ending,
    }));
}

const text = (tail: fc.Arbitrary<string>) =>
  fc.array(fc.oneof(plain, pathSegment(tail)), { minLength: 1, maxLength: 6 });

const hex = (character: string, upper: boolean): string => {
  const code = character.charCodeAt(0).toString(16).padStart(4, "0");
  return `\\u${upper ? code.toUpperCase() : code}`;
};

/** A JSON string encoder that writes `\u` escapes for everything but printable ASCII, and for
 *  quotes, `<`, `>`, `&`, a backtick and `)`, as some encoders do. */
const escapingAll =
  (upper: boolean) =>
  (value: string): string =>
    `"${Array.from(value, (character) =>
      character === "\\"
        ? "\\\\"
        : /[\x20-\x7e]/.test(character) && !/["'<>&`)]/.test(character)
          ? character
          : Array.from({ length: character.length }, (_, at) =>
              hex(character.charAt(at), upper),
            ).join(""),
    ).join("")}"`;

const ENCODERS: [string, (value: string) => string][] = [
  ["JSON.stringify", JSON.stringify],
  ["lower-case \\u escapes", escapingAll(false)],
  ["upper-case \\u escapes", escapingAll(true)],
];

const encode = (encoder: (value: string) => string, value: string, depth: number): string => {
  let encoded = value;
  for (let level = 0; level < depth; level += 1) encoded = encoder(encoded);
  return encoded;
};

const decode = (value: string, depth: number): string => {
  let decoded = value;
  for (let level = 0; level < depth; level += 1) decoded = JSON.parse(decoded) as string;
  return decoded;
};

const relabel = (segments: Segment[], redact: (text: string) => string): string =>
  segments
    .map((segment) =>
      redact === redactToSecretLabel
        ? segment.redacted.replace(/\[REDACTED_(?:LOCAL|RUNTIME)_PATH\]/g, REDACTION_MARKERS.secret)
        : segment.redacted,
    )
    .join("");

describe("paths in JSON-encoded text, as a property", () => {
  it.each([redactText, redactToSecretLabel])(
    "one level deep, the decoded output is the decoded text with each path replaced (%o)",
    (redact) => {
      fc.assert(
        fc.property(
          text(characters(TAIL, 0, 10)),
          fc.constantFrom(...ENCODERS),
          (segments, [, encoder]) => {
            const written = segments.map((segment) => segment.text).join("");
            const output = decode(redact(encode(encoder, written, 1)), 1);
            expect(output).toBe(relabel(segments, redact));
          },
        ),
        propertyParameters(),
      );
    },
  );

  it("two and three levels deep, no character of a path survives", () => {
    fc.assert(
      fc.property(
        text(characters(TAIL, 0, 10)),
        fc.constantFrom(...ENCODERS),
        fc.constantFrom(2, 3),
        (segments, [, encoder], depth) => {
          const written = segments.map((segment) => segment.text).join("");
          // No encoder escapes a `q`, and only paths hold one.
          const output = redactText(encode(encoder, written, depth));
          expect(output).not.toContain("q");
          expect(containsSensitive(output)).toBe(false);
        },
      ),
      propertyParameters(),
    );
  });

  // Deeper than one level, `\\n` is a line break or, one level up, a backslash and an `n` in the
  // path, so the path runs on through it. A quote is still an odd run of backslashes and a `"`,
  // except when an encoder writes it as `\u0022` and the text is three or more levels deep.
  it("the framing still parses at every depth JSON.stringify writes and two deep for \\u quotes", () => {
    fc.assert(
      fc.property(
        text(characters(TAIL, 0, 10)),
        fc.constantFrom(
          ...[2, 3, 4].map((depth) => [ENCODERS[0]![1], depth] as const),
          ...ENCODERS.slice(1).map(([, encoder]) => [encoder, 2] as const),
        ),
        (segments, [encoder, depth]) => {
          const written = segments.map((segment) => segment.text).join("");
          expect(() => decode(redactText(encode(encoder, written, depth)), depth)).not.toThrow();
        },
      ),
      propertyParameters(),
    );
  });

  it("in raw text, a path without a backslash is redacted to the character that ends it", () => {
    const noBackslash = TAIL.filter((character) => character !== "\\");
    fc.assert(
      fc.property(text(characters(noBackslash, 0, 10)), (segments) => {
        expect(redactText(segments.map((segment) => segment.text).join(""))).toBe(
          relabel(segments, redactText),
        );
      }),
      propertyParameters(),
    );
  });
});
