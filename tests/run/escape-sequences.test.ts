import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { escapeSequences } from "../../src/run/escape-sequences.js";
import { escapeTexts, propertyParameters } from "../helpers/scrub-arbitraries.js";
import { modelEscapeSequences } from "../helpers/scrub-model.js";

describe("escapeSequences", () => {
  it("finds what the regex RunSecrets used found, on text of escape pieces", () => {
    fc.assert(
      fc.property(escapeTexts(), (text) => {
        expect(escapeSequences(text)).toEqual(modelEscapeSequences(text));
      }),
      propertyParameters(),
    );
  });

  it("ends a command at the first bell character after it, or else at the last string terminator", () => {
    expect(escapeSequences("a\x1b]0;t\x07b\x07")).toEqual([[1, 7]]);
    // With no bell character after it, the command runs to the last terminator and takes the text between.
    expect(escapeSequences("\x1b]0;a\x1b\\ b \x1b]0;c\x1b\\ d")).toEqual([[0, 17]]);
    expect(escapeSequences("\x1b]0;a \x1b]")).toEqual([]);
  });

  it("reads control sequences, two-byte escapes, JSON-escaped sequences and percent runs", () => {
    expect(escapeSequences("\x1b[0;31mred\x1b[0m \x1b7 \x1b[0;")).toEqual([
      [0, 7],
      [10, 14],
      [15, 17],
    ]);
    expect(escapeSequences("\\u001b[31m \\u001b]0;t\\u0007 \\u001b]0;t\\u001b\\\\")).toEqual([
      [0, 10],
      [11, 27],
      [28, 46],
    ]);
    expect(escapeSequences("a%41%4 %zz%e2%80")).toEqual([
      [1, 4],
      [10, 16],
    ]);
  });
});
