// The prose rules check-code-prose.mjs counts, shared with the tests that hold other prose (the
// starter files `humanish init` writes) to the same rules. Examples are code spans, which no rule
// counts.

// All-caps words that are names or comment tags, not emphasis.
export const ACRONYMS = new Set(
  (
    "TODO NOTE API CDP CI CLI CPU CSP CSS CUA DB DI DNS DOM DPR ESM GPU HTML HTTP HTTPS ID ISO JSON JWT " +
    "KVM LLM MB KB GB MIME NDJSON OIDC OTP PID PNG POSIX PR PTY SDK SHA SMTP SSH TCP TLS TTL " +
    "TTY TUI UI URL USD UTC UTF UUID VM VNC XDG XOR YAML ZDR E2B AX UX GET POST PUT HEAD RFC " +
    "OS PDF JPEG JS TS ASCII EOF IP IO MCP OAUTH OK EXIF DOCTYPE RGB RGBA WSL PCM WAV PII IHDR " +
    "ENOENT EEXIST ENOTEMPTY ENOTDIR EISDIR EACCES EPERM EPIPE EBUSY ELOOP EXDEV ENOTSUP EOPNOTSUPP SIGTERM SIGKILL SIGINT " +
    "CA GNU GUI LTS OCR SSG ABA CIDR SNI TOCTOU DSF ENOSPC OSS SQL " +
    "CRC CSD EAGAIN EMFILE ENOMEM FIFO HAR ICC IDAT IEND IME NUL OOM PEM PHI RPC SIGHUP SMS SVG TOML UA " +
    "VFR XFCE XML GPT MAS MDN ADR GPG AI FCP JSX TSX TTF OG LD"
  ).split(" "),
);

/** An issue reference such as `#123`, except inside `TODO(#123)`. */
export const ISSUE_REF = /(?<!TODO\()#\d{1,5}\b/g;

/** A review tag such as `FIX-5`. */
export const FIX_TAG = /\bFIX-\d+\b/g;

// `lane` or `lanes` as a word, except in an array (`lanes[]`), a flag (`--lanes`), an id
// (`lane-01`, `lane-NN`) or the `per-lane-worlds` topology.
export const LANE_WORD = /(?<!\w|--)lanes?(?![\w[]|-\d|-NN|-worlds)/gi;
// Under src/study/migrate/, which reads humanish.lab.v2 files, a comment may also name the v2
// property path `actors[0].lanes`.
const MIGRATE_LANE_WORD = /(?<![\w.]|--)lanes?(?![\w[]|-\d|-NN|-worlds)/gi;

/** The `lane` pattern for the comments and test names of a file, by its repo-relative path. */
export function laneWordFor(file) {
  return file.startsWith("src/study/migrate/") ? MIGRATE_LANE_WORD : LANE_WORD;
}

// A word with two or more capitals and no lowercase letter, alone or as one part of a hyphenated
// compound: `NOT`, `LOAD-BEARING` and `operator-DECLARED` each count once. A compound whose caps
// parts are all in `ACRONYMS` (`JSON-RPC`, `E2B-desktop`) is a name. Path segments (`/lobby/CODE`)
// and placeholders (`<PORT>`) are not counted.
export const CAPS_RUN = /(?<![\w/<])(?:[A-Za-z0-9]+-)*[A-Z]{2,}(?:-[A-Za-z0-9]+)*(?![\w/>])/g;

/** True when a `CAPS_RUN` match has a caps part outside `ACRONYMS`, so it reads as emphasis. */
export function isCapsEmphasis(run) {
  return run
    .split("-")
    .filter((part) => /^[A-Z]{2,}$/.test(part))
    .some((part) => !ACRONYMS.has(part));
}

// An em dash, or two hyphens standing alone between spaces. A flag (`--count`) and a rule (`---`)
// are not dashes, and neither is the ` -- ` that separates a lint directive from its reason.
export const EM_DASH = /—|(?<=\s)--(?=\s)/g;
export const LINT_DIRECTIVE = /^(\s*(?:oxlint|eslint)-(?:disable|enable)\S*[^\n]*?\s)--(?=\s)/;

// Word kinds matched against prose with code spans blanked.
export const WORD_KINDS = {
  "invariant-refs": /\binvariants? #?\d+\b/gi,
  authority: /\b(?:load-bearing|doctrine)\b/gi,
  archaeology:
    /\b(?:red-team(?:ed)?|blocker \d+|goal packet|safety contract item \d+|this slice|layer[- ]\d+)\b/gi,
  "seat-comments": /\bseats?\b/gi,
  "cua-route": /\bcua (?:route|backend|lab)s?\b/gi,
  honest: /\bhonest(?:ly|y)?\b/gi,
  history: /\b(?:used to|rediscovered|post-?mortem)\b/gi,
};

/** The text with each code span blanked to spaces, so offsets and line numbers still hold. */
export function blankCodeSpans(text) {
  return text.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}
