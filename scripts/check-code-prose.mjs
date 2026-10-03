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
// - `authority`: `load-bearing`, `doctrine`. Say what the code depends on. (`canonical` stays
//   legal: a canonical form or path is a precise term.)
// - `seat-comments`, `cua-route`, `honest`, `history`: words held at today's count while comments move to
//   participant, the computer-use route, a plain claim and the current behavior.
// - `series-codes`, `name-refs`: a test name that opens with a code such as `L14:` or `W5:`, or
//   that cites an issue (`#123`). Test names only; the name says the behavior.
// - The `labs` root reads the `title` and `description` of each `humanish/studies/*.yaml`, which
//   `lab list`, `lab inspect` and the TUI show, and counts every kind above except the two test-name
//   kinds, at `prose.labs.<kind>`.
// - `title-case-headers`: a Title Case header (`## How It Works`) in a root `*.md` file, outside
//   fenced code, capped at `prose.markdown.title-case-headers`. Headers there are sentence-case
//   verb phrases (`## Read the results`).
// - `string-*`: em dashes, issue references and caps, plus `a later slice`, harness rationale words
//   (`fail closed`, `by construction`, `hollow`, `honest`, `safety lie`), `(s)` plurals and `CUA`
//   (say computer-use), counted in src string literals and template text: what a person reads in
//   an error, a warning or command output. Model prompts and the terminal's transcoding table are
//   not counted (`STRING_EXCLUDED`), nor is the statement after a `prose-check: model prompt` or
//   `prose-check: script` comment, a string literal type, a string with no whitespace, or a caps
//   word the shell reads (`${DISPLAY}`, `LANG=C`, `kill -INT`) or a file stem (`AGENTS.md`).
// - `prompt-markers`, `script-markers`: each `prose-check: model prompt` or `prose-check: script`
//   comment in src. A marker exempts the statement after it, so a new one raises its cap where a
//   reviewer sees it.
//
// The current docs are read too, by lib/doc-prose.mjs, under the roots `docs`, `site` and
// `evidence`, for the kinds `issue-refs`, `caps`, `em-dashes`, `invariant-refs`, `authority`,
// `honest`, `archaeology` (which adds `SLICE 2` and `phase 2` for docs) and `contrast` (`not
// just`, `not merely`, `rather than`).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CAPS_FILE, flattenCaps, holdToCaps, readCaps } from "./lib/caps.mjs";
import {
  DOC_WORD_KINDS,
  ROOT_GUIDES,
  docProse,
  docRootOf,
  isDocCapsEmphasis,
} from "./lib/doc-prose.mjs";
import { parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";
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

// Each root is read recursively; node_modules, dist and Next's .next build output are skipped. A
// root's caps are under `prose.<root>` in scripts/caps.json. `site-code` reads the source files
// under site/; the .mdx pages are not source files.
const ROOTS = ["src", "tests", "scripts", "tui", "observer", "site-code"];
const ROOT_DIRS = { "site-code": "site" };
const SOURCE_FILE = /\.(?:ts|tsx|mts|mjs|js)$/;
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|dist|\.next)(?:\/|$)/;

function filesOf(root) {
  const dir = ROOT_DIRS[root] ?? root;
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

// Files whose strings are not read by a person: model prompts, the table that maps characters a
// terminal cannot render to ASCII stand-ins, and the email catch server's Python source.
const STRING_EXCLUDED = new Set([
  "src/analysis/execute.ts",
  "src/comms/sandbox-catch-script.ts",
  "src/routes/computer-use/participant-prompt.ts",
  "src/routes/shared-world/lobby-code.ts",
  "src/routes/terminal/encoding.ts",
]);

// Kinds counted in src string literals and template text. A CSS color (`color:#111`,
// `solid #111}`) and an HTML entity (`&#39;`) are not issue references, and `http(s)` is a URL
// scheme, not a plural.
const STRING_KINDS = {
  "string-em-dashes": /—/g,
  "string-issue-refs": /(?<![&:\w])(?<!TODO\()#\d{1,5}(?![\w;}])/g,
  "string-slice": /\b(?:a|later|this|first|next) slice\b/gi,
  "string-rationale":
    /\b(?:fails? closed|fail-closed|by construction|hollow|honest(?:ly|y)?|safety lie)\b/gi,
  "string-plural-s": /[a-z](?<!\bhttp)\(s\)/g,
  "string-cua": /\bCUA\b/g,
};
const STRING_KIND_NAMES = [
  ...Object.keys(STRING_KINDS),
  "string-caps",
  "prompt-markers",
  "script-markers",
];

// The title and description of each committed study, which `lab list`, `lab inspect` and the TUI
// show. They are held to the comment rules; the test-name kinds do not apply. The caps keep the
// `labs` root name until the rename's prose PR.
const STUDIES_DIR = "humanish/studies";
const STUDY_KINDS = KINDS.filter((kind) => kind !== "series-codes" && kind !== "name-refs");
const STUDY_FIELDS = ["title", "description"];

/** Every hit, keyed by its cap path in scripts/caps.json: `prose.src.caps`, `prose.tests.caps`, ... */
const hits = new Map([
  ...ROOTS.flatMap((root) => KINDS.map((kind) => [`prose.${root}.${kind}`, []])),
  ...STUDY_KINDS.map((kind) => [`prose.labs.${kind}`, []]),
  ["prose.markdown.title-case-headers", []],
  ...STRING_KIND_NAMES.map((kind) => [`prose.src.${kind}`, []]),
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

// A comment holding one of these marks the statement right after it as text no person reads as a
// message: a prompt tuned for a model, or a program in another language (a shell, Python or
// browser script).
const PROMPT_MARK = /prose-check: model prompt/;
const SCRIPT_MARK = /prose-check: script\b/;
const isUnreadMark = (comment) =>
  PROMPT_MARK.test(comment.value) || SCRIPT_MARK.test(comment.value);

/** The [start, end) ranges of the statements a `PROMPT_MARK` or `SCRIPT_MARK` comment marks. */
function unreadRanges(parsed, text) {
  const marks = parsed.comments.filter(isUnreadMark).map((c) => c.end);
  const ranges = [];
  if (marks.length === 0) return ranges;
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    // The program can start at its first statement, so it never counts as the marked one.
    if (node.type !== "Program" && typeof node.start === "number") {
      for (const end of marks) {
        if (node.start >= end && /^\s*$/.test(text.slice(end, node.start))) {
          ranges.push([node.start, node.end]);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(parsed.program);
  return ranges;
}

const quasiText = (quasi) => quasi.value.cooked ?? quasi.value.raw;

/**
 * Every string literal and template text in a program, with its offset in the file. A string with
 * no whitespace is a code token, a path or an enum value (`"EXECUTE"`, `"ESRCH"`, `"/tmp/x.XXXXXX"`)
 * and is skipped, unless a template splices it into its text (`${ok ? "PROVEN" : "not seen"}`).
 * A template counts as one string for the whitespace test.
 */
function* stringsOf(node, spliced = false) {
  if (node === null || typeof node !== "object") return;
  // A string literal type (`mode: "fail-closed" | "record-evidence"`) names a value, not a message.
  if (node.type === "TSLiteralType") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* stringsOf(child, spliced);
    return;
  }
  if (node.type === "Literal") {
    if (typeof node.value === "string" && (spliced || /\s/.test(node.value))) {
      yield { text: node.value, start: node.start };
    }
    return;
  }
  if (node.type === "TemplateLiteral") {
    if (/\s/.test(node.quasis.map(quasiText).join(""))) {
      for (const quasi of node.quasis) yield { text: quasiText(quasi), start: quasi.start };
    }
    yield* stringsOf(node.expressions, true);
    return;
  }
  // A branch of `a ? b : c` or `a ?? b` inside a template is still spliced text; its test is not.
  const branches =
    spliced && (node.type === "ConditionalExpression" || node.type === "LogicalExpression");
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent") yield* stringsOf(child, branches && key !== "test");
  }
}

/**
 * True when a caps word in a string is a name the shell reads (`$HOME`, `${DISPLAY:-:0}`, `LANG=C`,
 * `kill -INT`, `--default-signal=INT,TERM`, `x.XXXXXX`) or a file stem (`AGENTS.md`).
 */
function isCodeName(prose, match) {
  const end = match.index + match[0].length;
  return /[${.,=-]/.test(prose[match.index - 1] ?? "") || /^(?:=|\.\w)/.test(prose.slice(end));
}

/** Counts the string kinds in one src string. Code spans inside it are not counted. */
function scanString(text, at) {
  const prose = blankCodeSpans(text);
  for (const [kind, pattern] of Object.entries(STRING_KINDS)) {
    for (const match of prose.matchAll(pattern)) hits.get(`prose.src.${kind}`).push(at(match));
  }
  for (const match of prose.matchAll(CAPS_RUN)) {
    if (isCapsEmphasis(match[0]) && !isCodeName(prose, match)) {
      hits.get("prose.src.string-caps").push(at(match));
    }
  }
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
    if (root === "src") {
      for (const comment of parsed.comments) {
        if (PROMPT_MARK.test(comment.value)) {
          hits
            .get("prose.src.prompt-markers")
            .push(`${file}:${lineOf(comment.start)} model prompt`);
        }
        if (SCRIPT_MARK.test(comment.value)) {
          hits.get("prose.src.script-markers").push(`${file}:${lineOf(comment.start)} script`);
        }
      }
    }
    if (root === "src" && !STRING_EXCLUDED.has(file)) {
      const unread = unreadRanges(parsed, text);
      for (const string of stringsOf(parsed.program)) {
        if (unread.some(([start, end]) => string.start >= start && string.start < end)) continue;
        scanString(string.text, (match) => `${file}:${lineOf(string.start)} ${match[0]}`);
      }
    }
    // Most source files make no test call; skip their syntax tree walk.
    if (!TEST_CALL_TEXT.test(text)) continue;
    forEachTestName(parsed.program, (name, offset) => {
      const at = (match) => `${file}:${lineOf(offset)} ${match[0].trim()}`;
      scan(name, root, at, { testName: true });
    });
  }
}

const studyFiles = existsSync(STUDIES_DIR)
  ? readdirSync(STUDIES_DIR)
      .filter((name) => name.endsWith(".yaml"))
      .sort()
  : [];
for (const name of studyFiles) {
  const file = `${STUDIES_DIR}/${name}`;
  const text = readFileSync(file, "utf8");
  const study = parseYaml(text);
  for (const field of STUDY_FIELDS) {
    const value = study?.[field];
    if (typeof value !== "string") continue;
    const line = text.split("\n").findIndex((row) => row.startsWith(`${field}:`)) + 1;
    scan(value, "labs", (match) => `${file}:${line} ${field} ${match[0]}`, { testName: false });
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

// The docs roots, counted over the pages docRootOf names.
const DOC_ROOTS = ["docs", "site", "evidence"];
const DOC_KINDS = ["issue-refs", "caps", "em-dashes", ...Object.keys(DOC_WORD_KINDS)];
for (const root of DOC_ROOTS) {
  for (const kind of DOC_KINDS) hits.set(`prose.${root}.${kind}`, []);
}
/** Every page under `dir`, recursively, with node_modules and dist skipped. */
const pagesUnder = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((file) => `${dir}/${file.split("\\").join("/")}`)
        .filter((file) => !SKIPPED_DIR.test(file))
    : [];
const docPages = [
  ...ROOT_GUIDES.filter((file) => existsSync(file)),
  ...pagesUnder("docs"),
  ...pagesUnder("site/content/docs"),
]
  .filter((file) => docRootOf(file) !== undefined)
  .sort();
for (const file of docPages) {
  const root = docRootOf(file);
  const text = readFileSync(file, "utf8");
  const prose = docProse(text);
  const add = (kind, match) =>
    hits
      .get(`prose.${root}.${kind}`)
      .push(`${file}:${text.slice(0, match.index).split("\n").length} ${match[0]}`);
  for (const match of prose.matchAll(ISSUE_REF)) add("issue-refs", match);
  for (const match of prose.matchAll(CAPS_RUN)) if (isDocCapsEmphasis(match[0])) add("caps", match);
  for (const match of prose.matchAll(EM_DASH)) add("em-dashes", match);
  for (const [kind, pattern] of Object.entries(DOC_WORD_KINDS)) {
    for (const match of prose.matchAll(pattern)) add(kind, match);
  }
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
