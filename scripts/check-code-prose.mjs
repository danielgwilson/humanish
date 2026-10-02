#!/usr/bin/env node
// Counts kinds of prose in comments and test names under each root in `ROOTS`. A test name is the
// first string argument of an it, test or describe call, and is read like a comment. Each count is
// held to its cap in scripts/caps.json, at `prose.<root>.<kind>`, by the rules in lib/caps.mjs: a
// count above or below its cap fails, and so does a count with no cap. Code spans are never
// counted, so the examples below are written as code spans.
//
// - `issue-refs`, `fix-tags`, `archaeology`: history that belongs in issues and commit messages. Issue
//   references (`#123`, except in `TODO(#123)`), review tags (`FIX-5`), and review or plan
//   labels (`red-team`, `blocker 2`, `goal packet`, `safety contract item 4`, `this slice`,
//   `layer 6`).
// - `caps`: all-caps emphasis (`NOT`, `ONLY`, `LOAD-BEARING`), except the names in `ACRONYMS`
//   (scripts/lib/prose-rules.mjs).
// - `lane-comments`: the retired word `lane`, which `CONTEXT.md` replaces with participant. The
//   contract spellings it lists (`lanes[]`, `laneId`, `per-lane-worlds`, `lane-NN`, `--lanes`)
//   are not counted.
// - `em-dashes`: `—`, or ` -- ` between words. A colon, a comma or two sentences says the same.
// - `invariant-refs`: `invariant 6`. The numbers live in docs/principles/invariants-and-defaults.md
//   and drift; name the rule instead.
// - `authority`: `load-bearing`, `doctrine`, `canonical`. Say what the code depends on.
// - `seat-comments`, `cua-route`, `honest`, `history`: words held at today's count while comments move to
//   participant, the computer-use route, a plain claim and the current behavior.
// - `series-codes`, `name-refs`: a test name that opens with a code such as `L14:` or `W5:`, or
//   that cites an issue (`#123`). Test names only; the name says the behavior.
// - `title-case-headers`: a Title Case header (`## How It Works`) in a root `*.md` file, outside
//   fenced code, capped at `prose.markdown.title-case-headers`. Headers there are sentence-case
//   verb phrases (`## Read the results`).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CAPS_FILE, flattenCaps, holdToCaps, readCaps } from "./lib/caps.mjs";
import { parseSync } from "oxc-parser";
import {
  CAPS_RUN,
  EM_DASH,
  FIX_TAG,
  ISSUE_REF,
  LANE_WORD,
  LINT_DIRECTIVE,
  WORD_KINDS,
  blankCodeSpans,
  isCapsEmphasis,
} from "./lib/prose-rules.mjs";

// Each root is read recursively; node_modules and dist are skipped. src keeps the bare flag names.
const ROOTS = ["src", "tests", "scripts", "tui"];
const SOURCE_FILE = /\.(?:ts|tsx|mts|mjs|js)$/;
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|dist)(?:\/|$)/;

function filesOf(dir) {
  // A checkout without the folder has nothing to count there; its caps still apply.
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => SOURCE_FILE.test(file) && !SKIPPED_DIR.test(file))
    .map((file) => join(dir, file))
    .sort();
}

// A test name that opens with a series code (`L14:`, `W5.`) instead of the behavior.
const SERIES_CODE = /^\s*[A-Z]{1,3}\d+[a-z]?\s*[:.)]/g;

const KINDS = [
  "issue-refs",
  "fix-tags",
  "caps",
  "lane-comments",
  "em-dashes",
  ...Object.keys(WORD_KINDS),
  "series-codes",
  "name-refs",
];

const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    caps: { type: "string", default: CAPS_FILE },
  },
});

/** Every hit, keyed by its cap path in scripts/caps.json: `prose.src.caps`, `prose.tests.caps`, ... */
const hits = new Map([
  ...ROOTS.flatMap((root) => KINDS.map((kind) => [`prose.${root}.${kind}`, []])),
  ["prose.markdown.title-case-headers", []],
]);

/** Counts each kind in one piece of prose. `at` turns a match into its `file:line word` entry. */
function scan(text, root, at, { testName }) {
  const add = (kind, match) => hits.get(`prose.${root}.${kind}`).push(at(match));
  // Code spans hold names and examples, so no kind counts inside them.
  const prose = blankCodeSpans(text);
  // A test name keeps its own issue-ref count, held at 0, so a ref removed from a comment cannot
  // make room for one in a name.
  const refKind = testName ? "name-refs" : "issue-refs";
  for (const match of prose.matchAll(ISSUE_REF)) add(refKind, match);
  for (const match of prose.matchAll(FIX_TAG)) add("fix-tags", match);
  for (const match of prose.matchAll(CAPS_RUN)) if (isCapsEmphasis(match[0])) add("caps", match);
  for (const match of prose.matchAll(LANE_WORD)) add("lane-comments", match);
  const dashProse = prose.replace(LINT_DIRECTIVE, "$1  ");
  for (const match of dashProse.matchAll(EM_DASH)) add("em-dashes", match);
  for (const [kind, pattern] of Object.entries(WORD_KINDS)) {
    for (const match of prose.matchAll(pattern)) add(kind, match);
  }
  if (testName) for (const match of prose.matchAll(SERIES_CODE)) add("series-codes", match);
}

const TEST_CALLS = new Set(["it", "test", "describe"]);
const TEST_CALL_TEXT = /\b(?:it|test|describe)\s*[.(]/;

/** `it`, `it.skip`, `describe.each(rows)` and `test.concurrent.each(rows)` all name a test call. */
function testCallName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") return testCallName(callee.object);
  if (callee.type === "CallExpression") return testCallName(callee.callee);
  return undefined;
}

/** The first argument's text when it is a string or a template, else undefined. */
function nameText(argument) {
  if (argument?.type === "Literal" && typeof argument.value === "string") return argument.value;
  if (argument?.type === "TemplateLiteral") {
    return argument.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("${}");
  }
  return undefined;
}

/** Calls `visit` with every it/test/describe name in the program, and its offset in the file. */
function forEachTestName(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) forEachTestName(child, visit);
    return;
  }
  if (node.type === "CallExpression" && TEST_CALLS.has(testCallName(node.callee) ?? "")) {
    const name = nameText(node.arguments[0]);
    if (name !== undefined) visit(name, node.arguments[0].start);
  }
  for (const [key, child] of Object.entries(node))
    if (key !== "parent") forEachTestName(child, visit);
}

for (const root of ROOTS) {
  for (const file of filesOf(root)) {
    const text = readFileSync(file, "utf8");
    const lineOf = (offset) => text.slice(0, offset).split("\n").length;
    const parsed = parseSync(file, text);
    for (const comment of parsed.comments) {
      // comment.value starts after the opening `//` or `/*`.
      const at = (match) => `${file}:${lineOf(comment.start + 2 + match.index)} ${match[0]}`;
      scan(comment.value, root, at, { testName: false });
    }
    // Most source files make no test call; skip their syntax tree walk.
    if (!TEST_CALL_TEXT.test(text)) continue;
    forEachTestName(parsed.program, (name, offset) => {
      const at = (match) => `${file}:${lineOf(offset)} ${match[0].trim()}`;
      scan(name, root, at, { testName: true });
    });
  }
}

// A header of two or more capitalized words in a root markdown file. Fenced code is skipped.
const TITLE_CASE_HEADER = /^#{2,4} ([A-Z][a-z-]+)( (A|To|[A-Z][a-z-]+))+$/;
for (const file of readdirSync(".")
  .filter((name) => name.endsWith(".md"))
  .sort()) {
  let fenced = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced && TITLE_CASE_HEADER.test(line))
        hits.get("prose.markdown.title-case-headers").push(`${file}:${index + 1} ${line}`);
    });
}

const { flat, invalid } = flattenCaps(readCaps(values.caps));
if (invalid.length > 0) {
  process.stderr.write(`${values.caps}: not a whole number at ${invalid.join(", ")}.\n`);
  process.exit(2);
}
const proseCaps = new Map([...flat].filter(([path]) => path.startsWith("prose.")));
const { ok, rose } = holdToCaps({
  caps: proseCaps,
  counts: hits,
  list: values.list,
  file: values.caps,
  write: (text) => process.stdout.write(text),
});
if (rose.length > 0) {
  process.stdout.write(
    "A count rose. `node scripts/check-code-prose.mjs --list` prints every hit with its line. Move\n" +
      "history into the commit message or issue, and keep the comment to what the code does.\n",
  );
}
if (!ok) process.exitCode = 1;
