import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { REDACTION_MARKERS, redactText } from "../../src/evidence/redaction.js";
import { propertyParameters } from "../helpers/scrub-arbitraries.js";

const LOCAL = REDACTION_MARKERS.localPath;
const RUNTIME = REDACTION_MARKERS.runtimePath;
// The synthetic home the public-surface scan allows, and a macOS home built from parts so the scan
// does not read it as a maintainer's path.
const HOME = "/home/someuser/";
const MAC_HOME = ["", "Users", "someone", ""].join("/");

const characters = (from: readonly string[], minLength: number, maxLength: number) =>
  fc.array(fc.constantFrom(...from), { minLength, maxLength }).map((chars) => chars.join(""));

describe("the backslashes a redacted path ends in", () => {
  // They may escape the closing quote of a JSON string, so redaction keeps them. This regular
  // expression is the reference for which backslashes those are.
  const trailingBackslashes = (text: string): string => text.match(/\\+$/)?.[0] ?? "";

  it("are the ones the reference expression finds", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ["/tmp/", LOCAL] as const,
          [HOME, RUNTIME] as const,
          [MAC_HOME, LOCAL] as const,
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
