/**
 * Counts the retired words (lane, seat, role, sim, study) in src/ identifiers and file names
 * outside the exempt paths (see lib/retired-words.ts), and the removed `backend` and `routesTo`
 * API names in the docs docs:check covers (doc-backend). Each count is held to its cap in
 * scripts/caps.json, at `vocabulary.<word>`, by the rules in lib/caps.mjs: a count above or below
 * its cap fails, and so does a count with no cap.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CAPS_FILE, flattenCaps, holdToCaps, readCaps } from "./lib/caps.mjs";
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
    list: { type: "boolean", default: false },
    caps: { type: "string", default: CAPS_FILE },
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

const { flat, invalid } = flattenCaps(readCaps(values.caps));
if (invalid.length > 0) {
  process.stderr.write(`${values.caps}: not a whole number at ${invalid.join(", ")}.\n`);
  process.exit(2);
}
const vocabularyCaps = new Map([...flat].filter(([path]) => path.startsWith("vocabulary.")));
const counts = new Map([...hits].map(([word, list]) => [`vocabulary.${word}`, list]));
const { ok, rose } = holdToCaps({
  caps: vocabularyCaps,
  counts,
  list: values.list,
  file: values.caps,
  write: (text) => process.stdout.write(text),
});
if (rose.length > 0) {
  process.stdout.write(
    "A retired word count rose. `pnpm exec tsx scripts/check-retired-words.ts --list` prints every\n" +
      "hit. Name new code for the participant, or keep the contract spelling in its translation module.\n" +
      "In docs, say route where a page says backend, and routeOf(config) for a routesTo predicate.\n",
  );
}
if (!ok) process.exitCode = 1;
