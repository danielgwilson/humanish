/**
 * Checks a golden format change: applies the current format to each golden as it was at a git ref
 * and compares the result with the golden in the working tree. Equal means the new format pins
 * the same values as the old one. It covers run-directory goldens (bundle copies as markers) and
 * loop goldens, whose layout (one line per logged call) must leave the value unchanged.
 * Usage: tsx scripts/check-golden-format.ts <ref>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { dedupeProjections } from "../tests/helpers/run-golden-projections.js";

const ref = process.argv[2];
if (!ref) {
  process.stderr.write("usage: tsx scripts/check-golden-format.ts <git-ref>\n");
  process.exit(2);
}

const goldens = readdirSync("tests/golden", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".json"))
  .map((file) => join("tests/golden", file))
  .sort();

let compared = 0;
const different: string[] = [];
for (const file of goldens) {
  let before: Record<string, unknown>;
  try {
    const text = execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    before = JSON.parse(text) as Record<string, unknown>;
  } catch {
    continue;
  }
  // Run-directory goldens hold a run.json; loop goldens live in tests/golden/loop/.
  const format =
    typeof before === "object" && before !== null && "run.json" in before
      ? dedupeProjections
      : file.startsWith(join("tests/golden", "loop"))
        ? (value: unknown) => value
        : undefined;
  if (format === undefined) continue;
  compared += 1;
  const after = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isDeepStrictEqual(format(before), after)) different.push(file);
}

process.stdout.write(
  `${compared} run-directory and loop goldens at ${ref}; ${compared - different.length} equal the working tree after the format change.\n`,
);
for (const file of different) process.stdout.write(`different: ${file}\n`);
if (different.length > 0 || compared === 0) process.exitCode = 1;
