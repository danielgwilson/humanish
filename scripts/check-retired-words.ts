/**
 * Counts the retired participant words (lane, seat, role, sim) in src/ identifiers outside the
 * exempt paths (see lib/retired-words.ts) and fails when a count rises above its cap in
 * package.json's vocabulary:check script. The caps only go down: lower one in the PR that
 * removes the words.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findRetiredWords, isCounted, RETIRED_WORDS } from "./lib/retired-words.js";

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(RETIRED_WORDS.map((word) => [`max-${word}`, { type: "string" }])),
    list: { type: "boolean", default: false },
  },
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((path) => isCounted(path) && existsSync(resolve(root, path)))
  .sort();

const hits = new Map<string, string[]>(RETIRED_WORDS.map((word) => [word, []]));
for (const file of files) {
  for (const hit of findRetiredWords(file, readFileSync(resolve(root, file), "utf8"))) {
    hits.get(hit.word)!.push(`${file}:${hit.line} ${hit.identifier}`);
  }
}

let failed = false;
for (const [word, list] of hits) {
  const max = values[`max-${word}`];
  const cap = typeof max === "string" ? Number(max) : undefined;
  const over = cap !== undefined && list.length > cap;
  failed ||= over;
  const status =
    cap === undefined ? "" : over ? ` (cap ${cap}, over by ${list.length - cap})` : ` (cap ${cap})`;
  process.stdout.write(`${word}: ${list.length}${status}\n`);
  if (values.list) process.stdout.write(list.map((hit) => `  ${hit}\n`).join(""));
}
if (failed) {
  process.stdout.write(
    "A retired word count rose. `pnpm exec tsx scripts/check-retired-words.ts --list` prints every\n" +
      "hit. Name new code for the participant, or keep the contract spelling in its translation module.\n",
  );
  process.exitCode = 1;
}
