// The prose of the current docs, read for check-code-prose.mjs the way it reads code comments.
// Three roots, each capped on its own: `docs` (docs/ outside history/ and evidence/, and the
// root guides), `site` (the site's docs pages) and `evidence` (dated study records, capped so a
// new record adds no tells but not cleaned, since a record keeps the words it was written in).
// docs/history/ and `CHANGELOG.md` are not read: history keeps its own words, and release notes
// cite pull requests by number.

import { ACRONYMS, CAPS_RUN, WORD_KINDS, blankCodeSpans } from "./prose-rules.mjs";

/** Root guides read with `docs`. */
export const ROOT_GUIDES = [
  "README.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "TELEMETRY.md",
];

/** The doc root a repo path belongs to, or undefined when the docs check does not read it. */
export function docRootOf(path) {
  if (ROOT_GUIDES.includes(path)) return "docs";
  if (path.startsWith("docs/") && path.endsWith(".md")) {
    if (path.startsWith("docs/history/")) return undefined;
    return path.startsWith("docs/evidence/") ? "evidence" : "docs";
  }
  if (path.startsWith("site/content/docs/") && path.endsWith(".mdx")) {
    // cli.mdx is generated from the Commander help text, which prose:check reads in src/.
    return path.endsWith("/cli.mdx") ? undefined : "site";
  }
  return undefined;
}

// Capitalized names docs write that comments never needed: repo file names and acronyms.
const DOC_NAMES = new Set(
  (
    "README AGENTS ARCHITECTURE CONTEXT CONTRIBUTING CHANGELOG TELEMETRY SECURITY LICENSE CLAUDE " +
    "AI ADR MIT CDN NPM OWASP SAST DRY KISS YAGNI UDP CSRF JSONL BYO TUN TURN AV PLTE WAI ARIA " +
    "PATH HOST PORT GIF CID CJK AAC RAM WCAG SLA SLSA DBML AGPL ELF VMM TERM SIGSTOP RPM NNP DRM " +
    "COPYING APT BPF AWS"
  ).split(" "),
);

/** True when a `CAPS_RUN` match in a doc reads as emphasis rather than a name. */
export function isDocCapsEmphasis(run) {
  return run
    .split("-")
    .filter((part) => /^[A-Z]{2,}$/.test(part))
    .some((part) => !ACRONYMS.has(part) && !DOC_NAMES.has(part));
}

/** A contrast frame: `not just`, `not merely`, `rather than`. */
export const CONTRAST = /\b(?:not just|not merely|rather than)\b/gi;

// Docs label history the comment rules do not see: `SLICE 2`, `phase 2`, `PR1 of`.
const DOC_ARCHAEOLOGY = /\b(?:slices? \d+|phase \d+|PR ?\d+ of)\b/gi;

/** The word kinds the docs check counts, by kind. */
export const DOC_WORD_KINDS = {
  "invariant-refs": WORD_KINDS["invariant-refs"],
  authority: WORD_KINDS.authority,
  honest: WORD_KINDS.honest,
  archaeology: new RegExp(
    `${WORD_KINDS.archaeology.source}|${DOC_ARCHAEOLOGY.source}`,
    WORD_KINDS.archaeology.flags,
  ),
  contrast: CONTRAST,
};

const blank = (span) => span.replace(/[^\n]/g, " ");

/**
 * The prose of a Markdown page (`.md` or `.mdx`) with everything else blanked to spaces, so offsets
 * and line numbers still hold: front matter, fenced code, inline code, link targets, bare URLs and
 * markup tags.
 */
export function docProse(text) {
  let prose = text.replace(/^---\n[\s\S]*?\n---\n/, blank);
  prose = prose.replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?^\s*\2[^\n]*$/gm, blank);
  prose = blankCodeSpans(prose);
  prose = prose.replace(/\]\([^)\n]*\)/g, (span) => `]${blank(span.slice(1))}`);
  prose = prose.replace(/https?:\/\/[^\s)>\]]+/g, blank);
  return prose.replace(/<[^>\n]+>/g, blank);
}

export { CAPS_RUN };
