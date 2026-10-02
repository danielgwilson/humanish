#!/usr/bin/env node
// Counts kinds of prose in comments and test names under each root in `ROOTS`. A test name is the
// first string argument of an it, test or describe call, and is read like a comment. Each count is
// held to a flag in package.json's prose:check script, `--max-<kind>` for src and
// `--max-<kind>-<root>` for the other roots: a count above its cap fails, and so does one below it,
// so the PR that removes the prose lowers the cap. A count with no flag fails too, so a merge that
// drops a flag cannot leave that count unchecked. Code spans are never counted, so the examples
// below are written as code spans.
//
// - `issue-refs`, `fix-tags`, `archaeology`: history that belongs in issues and commit messages. Issue
//   references (`#123`, except in `TODO(#123)`), review tags (`FIX-5`), and review or plan
//   labels (`red-team`, `blocker 2`, `goal packet`, `safety contract item 4`, `this slice`,
//   `layer 6`).
// - `caps`: all-caps emphasis (`NOT`, `ONLY`, `LOAD-BEARING`), except the names in `ACRONYMS`.
// - `lane-comments`: the retired word `lane`, which `CONTEXT.md` replaces with participant. The
//   contract spellings it lists (`lanes[]`, `laneId`, `per-lane-worlds`, `lane-NN`, `--lanes`)
//   are not counted.
// - `em-dashes`: `—`, or ` -- ` between words. A colon, a comma or two sentences says the same.
// - `invariant-refs`: `invariant 6`. The numbers live in docs/principles/invariants-and-defaults.md
//   and drift; name the rule instead.
// - `authority`: `load-bearing`, `doctrine`, `canonical`. Say what the code depends on.
// - `seat-comments`, `cua-route`, `honest`, `history`: words held at today's count while comments move to
//   participant, the computer-use route, a plain claim and the current behavior.
// - `series-codes`: a test name that opens with a code such as `L14:` or `W5:`. Test names only.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseSync } from "oxc-parser";

// All-caps words that are names or comment tags, not emphasis.
const ACRONYMS = new Set(
  (
    "TODO NOTE API CDP CI CLI CPU CSP CSS CUA DB DI DNS DOM DPR ESM GPU HTML HTTP HTTPS ID ISO JSON JWT " +
    "KVM LLM MB KB GB MIME NDJSON OIDC OTP PID PNG POSIX PR PTY SDK SHA SMTP SSH TCP TLS TTL " +
    "TTY TUI UI URL USD UTC UTF UUID VM VNC XDG XOR YAML ZDR E2B AX UX GET POST PUT HEAD RFC " +
    "OS PDF JPEG JS TS ASCII EOF IP IO MCP OAUTH OK EXIF DOCTYPE RGB RGBA WSL PCM WAV PII IHDR " +
    "ENOENT EEXIST ENOTEMPTY ENOTDIR EISDIR EACCES EPERM EPIPE EBUSY ELOOP EXDEV SIGTERM SIGKILL SIGINT " +
    "CA GNU GUI LTS OCR SSG ABA CIDR SNI TOCTOU DSF ENOSPC OSS SQL " +
    "CRC CSD EAGAIN EMFILE ENOMEM FIFO HAR ICC IDAT IEND IME NUL OOM PEM PHI RPC SIGHUP SMS SVG TOML UA " +
    "VFR XFCE XML GPT MAS"
  ).split(" "),
);

// Each root is read recursively; node_modules and dist are skipped. src keeps the bare flag names.
const ROOTS = [
  { dir: "src", suffix: "" },
  { dir: "tests", suffix: "-tests" },
  { dir: "scripts", suffix: "-scripts" },
  { dir: "tui", suffix: "-tui" },
];
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

// `lane` or `lanes` as a word, except in a property path (`actors[0].lanes`), an array
// (`lanes[]`), a flag (`--lanes`), an id (`lane-01`, `lane-NN`) or the `per-lane-worlds` topology.
const LANE_WORD = /(?<![\w.]|--)lanes?(?![\w[]|-\d|-NN|-worlds)/gi;

// A word with two or more capitals and no lowercase letter, alone or as one part of a hyphenated
// compound: `NOT`, `LOAD-BEARING` and `operator-DECLARED` each count once. A compound whose caps
// parts are all in `ACRONYMS` (`JSON-RPC`, `E2B-desktop`) is a name. Path segments (`/lobby/CODE`)
// and placeholders (`<PORT>`) are not counted.
const CAPS_RUN = /(?<![\w/<])(?:[A-Za-z0-9]+-)*[A-Z]{2,}(?:-[A-Za-z0-9]+)*(?![\w/>])/g;

// An em dash, or two hyphens standing alone between spaces. A flag (`--count`) and a rule (`---`)
// are not dashes, and neither is the ` -- ` that separates a lint directive from its reason.
const EM_DASH = /—|(?<=\s)--(?=\s)/g;
const LINT_DIRECTIVE = /^(\s*(?:oxlint|eslint)-(?:disable|enable)\S*[^\n]*?\s)--(?=\s)/;

// Word kinds matched against comment prose with code spans blanked.
const WORD_KINDS = {
  "invariant-refs": /\binvariants? #?\d+\b/gi,
  authority: /\b(?:load-bearing|doctrine|canonical(?:ly)?)\b/gi,
  archaeology:
    /\b(?:red-team(?:ed)?|blocker \d+|goal packet|safety contract item \d+|this slice|layer[- ]\d+)\b/gi,
  "seat-comments": /\bseats?\b/gi,
  "cua-route": /\bcua (?:route|backend|lab)s?\b/gi,
  honest: /\bhonest(?:ly|y)?\b/gi,
  history: /\b(?:used to|rediscovered|post-?mortem)\b/gi,
};

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
];

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      ROOTS.flatMap(({ suffix }) =>
        KINDS.map((kind) => [`max-${kind}${suffix}`, { type: "string" }]),
      ),
    ),
    list: { type: "boolean", default: false },
  },
});

/** Every hit, keyed by flag name without the `max-` prefix: `caps`, `caps-tests`, ... */
const hits = Object.fromEntries(
  ROOTS.flatMap(({ suffix }) => KINDS.map((kind) => [`${kind}${suffix}`, []])),
);

/** Counts each kind in one piece of prose. `at` turns a match into its `file:line word` entry. */
function scan(text, suffix, at, { testName }) {
  const add = (kind, match) => hits[`${kind}${suffix}`].push(at(match));
  // Code spans hold names and examples, so no kind counts inside them.
  const prose = text.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
  for (const match of prose.matchAll(/(?<!TODO\()#\d{1,5}\b/g)) add("issue-refs", match);
  for (const match of prose.matchAll(/\bFIX-\d+\b/g)) add("fix-tags", match);
  for (const match of prose.matchAll(CAPS_RUN)) {
    const parts = match[0].split("-").filter((part) => /^[A-Z]{2,}$/.test(part));
    if (parts.some((part) => !ACRONYMS.has(part))) add("caps", match);
  }
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

for (const { dir, suffix } of ROOTS) {
  for (const file of filesOf(dir)) {
    const text = readFileSync(file, "utf8");
    const lineOf = (offset) => text.slice(0, offset).split("\n").length;
    const parsed = parseSync(file, text);
    for (const comment of parsed.comments) {
      // comment.value starts after the opening `//` or `/*`.
      const at = (match) => `${file}:${lineOf(comment.start + 2 + match.index)} ${match[0]}`;
      scan(comment.value, suffix, at, { testName: false });
    }
    // Most source files make no test call; skip their syntax tree walk.
    if (!TEST_CALL_TEXT.test(text)) continue;
    forEachTestName(parsed.program, (name, offset) => {
      const at = (match) => `${file}:${lineOf(offset)} ${match[0].trim()}`;
      scan(name, suffix, at, { testName: true });
    });
  }
}

for (const kind of Object.keys(hits)) {
  const max = values[`max-${kind}`];
  if (max !== undefined && !/^\d+$/.test(max)) {
    process.stderr.write(`check-code-prose: --max-${kind}=${max} is not a whole number.\n`);
    process.exit(2);
  }
}

const rose = [];
const fell = [];
const uncapped = [];
for (const [kind, list] of Object.entries(hits)) {
  const max = values[`max-${kind}`];
  const cap = max === undefined ? undefined : Number(max);
  const count = list.length;
  if (cap === undefined) uncapped.push(`--max-${kind}=${count}`);
  if (cap !== undefined && count > cap) rose.push(kind);
  if (cap !== undefined && count < cap) fell.push(`--max-${kind}=${count}`);
  const status =
    cap === undefined
      ? ""
      : count > cap
        ? ` (cap ${cap}, over by ${count - cap})`
        : count < cap
          ? ` (cap ${cap}, under by ${cap - count})`
          : ` (cap ${cap})`;
  process.stdout.write(`${kind}: ${count}${status}\n`);
  if (values.list) process.stdout.write(list.map((hit) => `  ${hit}\n`).join(""));
}
if (rose.length > 0) {
  process.stdout.write(
    "A count rose. `node scripts/check-code-prose.mjs --list` prints every hit with its line. Move\n" +
      "history into the commit message or issue, and keep the comment to what the code does.\n",
  );
}
if (fell.length > 0) {
  process.stdout.write(
    `A count fell. Lower the cap in package.json's prose:check script in this PR: ${fell.join(" ")}.\n`,
  );
}
if (uncapped.length > 0) {
  process.stdout.write(
    `A count has no cap. Add it to package.json's prose:check script: ${uncapped.join(" ")}.\n`,
  );
}
if (rose.length > 0 || fell.length > 0 || uncapped.length > 0) process.exitCode = 1;
