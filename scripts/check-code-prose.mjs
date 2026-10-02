#!/usr/bin/env node
// Counts four kinds of prose in src/ comments. Three belong in issues and commit messages: issue
// references (#123, except in TODO(#123)), red-team tags (FIX-5) and all-caps emphasis (NOT, ONLY,
// NEVER). The fourth is the retired word "lane" or "lanes", which CONTEXT.md replaces with
// participant; the contract spellings it lists (`lanes[]`, `laneId`, `per-lane-worlds`, `lane-NN`,
// `--lanes`, and any code span) are not counted. Each count is held to a flag in package.json's
// prose:check script: a count above its cap fails, and so does one below it, so the PR that removes
// the prose lowers the cap.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseSync } from "oxc-parser";

const { values } = parseArgs({
  options: {
    "max-issue-refs": { type: "string" },
    "max-fix-tags": { type: "string" },
    "max-caps": { type: "string" },
    "max-lane-comments": { type: "string" },
    list: { type: "boolean", default: false },
  },
});

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
    "VFR XFCE XML"
  ).split(" "),
);

const files = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => join("src", file))
  .sort();

// "lane" or "lanes" as a word, except in a property path (`actors[0].lanes`), an array
// (`lanes[]`), a flag (`--lanes`), an id (`lane-01`, `lane-NN`) or the `per-lane-worlds` topology.
const LANE_WORD = /(?<![\w.]|--)lanes?(?![\w[]|-\d|-NN|-worlds)/gi;

const hits = { "issue-refs": [], "fix-tags": [], caps: [], "lane-comments": [] };
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const comment of parseSync(file, text).comments) {
    // comment.value starts after the opening `//` or `/*`.
    const at = (match) => {
      const line = text.slice(0, comment.start + 2 + match.index).split("\n").length;
      return `${file}:${line} ${match[0]}`;
    };
    for (const match of comment.value.matchAll(/(?<!TODO\()#\d{2,5}\b/g)) {
      hits["issue-refs"].push(at(match));
    }
    for (const match of comment.value.matchAll(/\bFIX-\d+\b/g)) hits["fix-tags"].push(at(match));
    // Code spans and path segments (`/lobby/CODE`) hold placeholders, not emphasis.
    const prose = comment.value.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
    for (const match of prose.matchAll(/(?<![\w/<-])[A-Z]{2,}(?![\w/>-])/g)) {
      if (!ACRONYMS.has(match[0])) hits.caps.push(at(match));
    }
    for (const match of prose.matchAll(LANE_WORD)) hits["lane-comments"].push(at(match));
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
for (const [kind, list] of Object.entries(hits)) {
  const max = values[`max-${kind}`];
  const cap = max === undefined ? undefined : Number(max);
  const count = list.length;
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
if (rose.length > 0 || fell.length > 0) process.exitCode = 1;
