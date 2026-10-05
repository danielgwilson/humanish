// A message must not name a library export a release removed: a caller reads `RunLabOptions.inProcess`
// or "run it with runConcurrentSharedWorld" and looks for a name it cannot import. Rename sweeps
// missed some, so this reads every src string literal and template text with the parser
// check-code-prose uses, and fails on any name 0.106.0, 0.107.0 or 0.109.0 removed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { stringsOf } from "../../scripts/lib/src-strings.mjs";
import { REMOVED_EXPORTS, REMOVED_IN_0_106, REMOVED_IN_0_107 } from "./removed-exports.js";

/**
 * Strings that name a removed export on purpose: the file, text on the string's source line, and
 * why. None does today; an entry needs a reason a caller benefits from the old name.
 */
const ALLOWED: readonly { file: string; line: string; reason: string }[] = [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** Each removed name and what a message says instead. */
const ADVICE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    REMOVED_IN_0_106.map((name) => [name, "what 0.106.0's release notes name for it"]),
  ),
  ...REMOVED_IN_0_107,
  ...REMOVED_EXPORTS,
};

/**
 * Removed names that are also ordinary words in messages, counted only in the shape of a call.
 * `doctor` was a library function and is still the `humanish doctor` command.
 */
const CALL_SHAPE_ONLY = new Set(["doctor"]);

const word = (names: string[]): string => names.join("|");
const NAMED = new RegExp(
  `(?<![\\w$])(?:${word(Object.keys(ADVICE).filter((name) => !CALL_SHAPE_ONLY.has(name)))})(?![\\w$])|(?<![\\w$.])(?:${word([...CALL_SHAPE_ONLY])})(?=\\()`,
  "g",
);

function hits(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    const parsed = parseSync(file, text);
    for (const string of stringsOf(parsed.program, false, true)) {
      for (const match of string.text.matchAll(NAMED)) {
        const line = text.slice(0, string.start).split("\n").length;
        const source = text.split("\n")[line - 1] ?? "";
        if (ALLOWED.some((entry) => entry.file === file && source.includes(entry.line))) continue;
        found.push(`${file}:${line} ${match[0]} (say ${ADVICE[match[0]]})`);
      }
    }
  }
  return found;
}

describe("messages name the library's current exports", () => {
  it("no src string names a name 0.106.0, 0.107.0 or 0.109.0 removed", () => {
    expect(hits()).toEqual([]);
  });

  it("lists every name each release's notes removed, and none that src/index.ts exports", () => {
    expect(REMOVED_IN_0_106).toHaveLength(300);
    // The 41 exports in the 0.107.0 table and the four hook bag options.
    expect(Object.keys(REMOVED_IN_0_107)).toHaveLength(45);
    const golden = JSON.parse(readFileSync("tests/golden/public-api.json", "utf8")) as {
      values: string[];
      types: string[];
    };
    const exported = new Set([...golden.values, ...golden.types]);
    expect(Object.keys(ADVICE).filter((name) => exported.has(name))).toEqual([]);
  });

  it("finds a removed name in a message, bare or as a call or option path", () => {
    const named = (text: string): string[] => [...text.matchAll(NAMED)].map((match) => match[0]);
    expect(named("Run the study with runStudy or runConcurrentSharedWorld.")).toEqual([
      "runConcurrentSharedWorld",
    ]);
    expect(named("set RunLabOptions.inProcess, or pass cuaHooks")).toEqual([
      "RunLabOptions",
      "cuaHooks",
    ]);
    expect(named("call doctor() first")).toEqual(["doctor"]);
    expect(named("run humanish doctor --study x; read ../doctor.js")).toEqual([]);
  });

  it("every allowlist entry still matches a string", () => {
    for (const entry of ALLOWED) {
      expect(readFileSync(entry.file, "utf8"), `${entry.file}: ${entry.reason}`).toContain(
        entry.line,
      );
    }
  });
});
