// A message must not name a library export 0.109.0 removed: a caller reads `RunLabOptions.inProcess`
// and looks for a type it cannot import. Two rename sweeps each missed some, so this reads every
// src string literal and template text with the parser check-code-prose uses, and
// fails on a removed name followed by `.` or `(`, the shape of an option path or a call.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { stringsOf } from "../../scripts/lib/src-strings.mjs";
import { REMOVED_EXPORTS } from "./removed-exports.js";

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

const NAMED = new RegExp(`\\b(?:${Object.keys(REMOVED_EXPORTS).join("|")})(?=[.(])`, "g");

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
        found.push(`${file}:${line} ${match[0]} (say ${REMOVED_EXPORTS[match[0]]})`);
      }
    }
  }
  return found;
}

describe("messages name the library's current exports", () => {
  it("no src string names an export 0.109.0 removed", () => {
    expect(hits()).toEqual([]);
  });

  it("every allowlist entry still matches a string", () => {
    for (const entry of ALLOWED) {
      expect(readFileSync(entry.file, "utf8"), `${entry.file}: ${entry.reason}`).toContain(
        entry.line,
      );
    }
  });
});
