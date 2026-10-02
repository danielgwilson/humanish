/**
 * Counts the retired words (lane, seat, role, sim, study) in src/ identifiers and file names
 * outside the exempt paths (see lib/retired-words.ts), and the removed `backend` and `routesTo`
 * API names in the docs docs:check covers (doc-backend). Each count is held to its cap in
 * package.json's vocabulary:check script: a count above its cap fails, and so does one below it,
 * so the PR that removes the words lowers the cap. A count with no flag fails too, so a merge that
 * drops a flag cannot leave that word unchecked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isCheckedDoc } from "./lib/doc-paths.js";
import {
  findDocBackendWords,
  findRetiredPathWords,
  findRetiredWords,
  isCounted,
  RETIRED_WORDS,
} from "./lib/retired-words.js";

const COUNTS = [...RETIRED_WORDS, "doc-backend"] as const;

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(COUNTS.map((word) => [`max-${word}`, { type: "string" }])),
    list: { type: "boolean", default: false },
  },
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((path) => path !== "" && existsSync(resolve(root, path)))
  .sort();
const files = tracked.filter(isCounted);

const hits = new Map<string, string[]>(COUNTS.map((word) => [word, []]));
for (const file of files) {
  for (const hit of findRetiredWords(file, readFileSync(resolve(root, file), "utf8"))) {
    hits.get(hit.word)!.push(`${file}:${hit.line} ${hit.identifier}`);
  }
  // A file's own name counts too, listed at line 0.
  for (const hit of findRetiredPathWords(file)) {
    hits.get(hit.word)!.push(`${file}:0 ${hit.identifier}`);
  }
}

for (const doc of tracked.filter(isCheckedDoc)) {
  for (const hit of findDocBackendWords(readFileSync(resolve(root, doc), "utf8"))) {
    hits.get("doc-backend")!.push(`${doc}:${hit.line} ${hit.word}`);
  }
}

for (const word of COUNTS) {
  const max = values[`max-${word}`];
  if (typeof max === "string" && !/^\d+$/.test(max)) {
    process.stderr.write(`check-retired-words: --max-${word}=${max} is not a whole number.\n`);
    process.exit(2);
  }
}

const rose: string[] = [];
const fell: string[] = [];
const uncapped: string[] = [];
for (const [word, list] of hits) {
  const max = values[`max-${word}`];
  const cap = typeof max === "string" ? Number(max) : undefined;
  const count = list.length;
  if (cap === undefined) uncapped.push(`--max-${word}=${count}`);
  if (cap !== undefined && count > cap) rose.push(word);
  if (cap !== undefined && count < cap) fell.push(`--max-${word}=${count}`);
  const status =
    cap === undefined
      ? ""
      : count > cap
        ? ` (cap ${cap}, over by ${count - cap})`
        : count < cap
          ? ` (cap ${cap}, under by ${cap - count})`
          : ` (cap ${cap})`;
  process.stdout.write(`${word}: ${count}${status}\n`);
  if (values.list) process.stdout.write(list.map((hit) => `  ${hit}\n`).join(""));
}
if (rose.length > 0) {
  process.stdout.write(
    "A retired word count rose. `pnpm exec tsx scripts/check-retired-words.ts --list` prints every\n" +
      "hit. Name new code for the participant, or keep the contract spelling in its translation module.\n" +
      "In docs, say route where a page says backend, and routeOf(config) for a routesTo predicate.\n",
  );
}
if (fell.length > 0) {
  process.stdout.write(
    `A retired word count fell. Lower the cap in package.json's vocabulary:check script in this PR: ${fell.join(" ")}.\n`,
  );
}
if (uncapped.length > 0) {
  process.stdout.write(
    `A count has no cap. Add it to package.json's vocabulary:check script: ${uncapped.join(" ")}.\n`,
  );
}
if (rose.length > 0 || fell.length > 0 || uncapped.length > 0) process.exitCode = 1;
