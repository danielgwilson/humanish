// Finds file paths in docs and src/ comments that name nothing in the repository. Renames and
// deletions leave these pointers behind, and a reader who follows one finds no file. The matching
// is deliberately narrow: a missed stale path costs less than a check that fails on URLs, package
// names and examples.
import { posix } from "node:path";
import { parseSync } from "oxc-parser";

export interface PathIssue {
  file: string;
  line: number;
  path: string;
  /** For a markdown link: the repo path the link resolves to from its file. */
  resolved?: string;
  /** For a link whose file exists: the `#fragment` that names no heading in it. */
  anchor?: string;
}

export interface RepoIndex {
  /** Every repo file path, relative to the root, with `/` separators. */
  files: ReadonlySet<string>;
  /** Every trailing slice of every file path (`route.ts`, `terminal/route.ts`, ...). */
  suffixes: ReadonlySet<string>;
  /** Every directory name that appears in a file path. */
  directoryNames: ReadonlySet<string>;
  /** Every directory path that holds a file, with a trailing `/` (`src/`, `src/run/`, ...). */
  directories: ReadonlySet<string>;
}

export function buildRepoIndex(paths: Iterable<string>): RepoIndex {
  const files = new Set<string>();
  const suffixes = new Set<string>();
  const directoryNames = new Set<string>();
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    files.add(path);
    for (let index = 0; index < segments.length; index++) {
      suffixes.add(segments.slice(index).join("/"));
      if (index < segments.length - 1) {
        directoryNames.add(segments[index]!);
        directories.add(`${segments.slice(0, index + 1).join("/")}/`);
      }
    }
  }
  return { files, suffixes, directoryNames, directories };
}

// docs/history/ holds dated goal packets, plans and the roadmap, which may name files that have
// since moved. docs/evidence/ holds the dated study records current pages cite, so it is checked.
const HISTORY_DIRECTORIES = ["docs/history/"];
const ROOT_GUIDES = new Set([
  "README.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
]);

export function isCheckedDoc(path: string): boolean {
  if (ROOT_GUIDES.has(path)) return true;
  if (path.startsWith("docs/") && path.endsWith(".md")) {
    return !HISTORY_DIRECTORIES.some((directory) => path.startsWith(directory));
  }
  return path.startsWith("site/content/") && path.endsWith(".mdx");
}

export function isCheckedSource(path: string): boolean {
  return path.startsWith("src/") && path.endsWith(".ts");
}

// A path from the repo root at the start of a token, behind optional `./` or `../` segments. It
// names a file with one of the listed extensions,
// or a directory written with a trailing `/`. A root folder inside another path (`tui/src/...`
// holds no root `src/` match) and paths with globs or placeholders do not match. `observer/` is
// left out because a run bundle has its own `observer/` folder, and `.js` because a `.js` name in
// a doc is often an emitted file or an ESM specifier.
const DOC_REPO_PATH =
  /(?<![\w.@/-])((?:\.{1,2}\/)*)((?:src|tests|scripts|docs|tui|site|runtime)\/[\w./-]*?(?:\.(?:tsx?|mts|mjs|json|ya?ml|md|py)|\/))(?![\w/-])/g;
// A link to a file or folder on this repository's main branch. Shipped docs use these for files
// the npm package leaves out, so any repo path is checked. Links to a tag or a commit name a
// snapshot and are left alone.
const REPO_URL = /github\.com\/[\w.-]+\/humanish\/(?:blob|tree)\/main\/([^\s()#?"'<>`|]+)/g;
// A source file named by its basename alone, in backticks (`route.ts`). It has to name a file that
// exists somewhere in the repo; a rename or deletion otherwise leaves the name behind unchecked.
const BARE_SOURCE_NAME = /`([\w.-]+\.(?:tsx?|mts|mjs))`/g;
// A markdown link target: `[text](target)` or `[text](<target> "title")`.
const MARKDOWN_LINK = /\]\(\s*<?([^()\s<>]+?)>?(?:\s+"[^"]*")?\s*\)/g;

export function findDocPathIssues(
  file: string,
  text: string,
  index: RepoIndex,
  /** The anchors a Markdown file declares, or undefined to skip anchor checks for it. */
  anchorsOf: (path: string) => ReadonlySet<string> | undefined = () => undefined,
): PathIssue[] {
  const issues: { offset: number; path: string; resolved?: string; anchor?: string }[] = [];
  // A markdown link resolves from the file that contains it. Every other path in a doc is a
  // reference written from the repo root.
  const linkSpans: [number, number][] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const target = match[1]!;
    const sameFile = target.startsWith("#");
    if (!sameFile && !isRelativeLinkTarget(target)) continue;
    const start = match.index + match[0].indexOf(target);
    linkSpans.push([start, start + target.length]);
    const [beforeHash, fragment] = target.split("#") as [string, string | undefined];
    const path = beforeHash.split("?")[0]!;
    const resolved = path === "" ? undefined : missingFromFile(file, path, index);
    if (resolved !== undefined) {
      issues.push({ offset: start, path, resolved });
      continue;
    }
    if (!fragment) continue;
    const linked = sameFile
      ? file
      : posix.normalize(posix.join(posix.dirname(file), decodeOrSelf(path)));
    const anchors = linked.endsWith(".md") ? anchorsOf(linked) : undefined;
    const anchor = decodeOrSelf(fragment);
    if (anchors && !anchors.has(anchor))
      issues.push({ offset: start, path, resolved: linked, anchor });
  }
  for (const match of text.matchAll(DOC_REPO_PATH)) {
    if (linkSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const prefix = match[1] ?? "";
    const path = match[2]!;
    const resolved = prefix ? posix.join(posix.dirname(file), prefix, path) : path;
    const known = resolved.endsWith("/") ? index.directories : index.files;
    if (!known.has(resolved)) issues.push({ offset: match.index, path: prefix + path });
  }
  for (const match of text.matchAll(BARE_SOURCE_NAME)) {
    if (!index.suffixes.has(match[1]!)) issues.push({ offset: match.index, path: match[1]! });
  }
  for (const match of text.matchAll(REPO_URL)) {
    // A URL that ends a sentence carries the full stop.
    const path = decodeOrSelf(match[1]!.replace(/[.,;:]+$/, ""));
    const directory = path.endsWith("/") ? path : `${path}/`;
    if (!index.files.has(path) && !index.directories.has(directory)) {
      issues.push({ offset: match.index, path });
    }
  }
  return issues
    .sort((left, right) => left.offset - right.offset)
    .map(({ offset, ...issue }) => ({ file, line: lineAt(text, offset), ...issue }));
}

/**
 * The anchors GitHub gives a Markdown file: one per heading outside code fences, slugged as GitHub
 * does (lowercase, punctuation other than `-` and `_` dropped, each space a hyphen, `-1`, `-2` on
 * repeats), plus explicit `<a id>` and `<a name>` anchors.
 */
export function markdownAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker !== undefined && (fence === undefined || fence === marker)) {
      fence = fence === undefined ? marker : undefined;
      continue;
    }
    if (fence !== undefined) continue;
    for (const explicit of line.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g))
      anchors.add(explicit[1]!);
    const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const repeats = seen.get(slug) ?? 0;
    seen.set(slug, repeats + 1);
    anchors.add(repeats === 0 ? slug : `${slug}-${repeats}`);
  }
  return anchors;
}

// URLs, site-absolute paths, same-page anchors and placeholders are not repo files.
function isRelativeLinkTarget(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[#/]/.test(target) && !/[<>{}*$]/.test(target);
}

/** The resolved repo path when the link names nothing relative to the doc, else undefined. */
function missingFromFile(file: string, path: string, index: RepoIndex): string | undefined {
  const decoded = decodeOrSelf(path);
  const resolved = posix.normalize(posix.join(posix.dirname(file), decoded));
  if (index.files.has(resolved)) return undefined;
  if (index.directories.has(resolved.endsWith("/") ? resolved : `${resolved}/`)) return undefined;
  return resolved;
}

function decodeOrSelf(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// A file-shaped token: optional `./` or `../` segments, then name segments joined by `/` or `.`,
// ending in a script extension. The lookbehind skips absolute paths, scoped packages (`@x/y`),
// template placeholders, globs, `node:` specifiers and quoted strings, which in comments are
// example values.
const COMMENT_PATH =
  /(?<![\w./@*<>{}$~:"'\\-])(?:\.{1,2}\/)*[\w-]+(?:[./][\w-]+)*\.(?:tsx?|mts|m?js)(?![\w-])/g;
// Bare names are checked only when they look like repo modules: lower-case, and for `.js` a
// hyphenated stem, so product names such as Next.js and node.js are left alone.
const BARE_MODULE = /^[a-z0-9][a-z0-9_.-]*$/;

export function findCommentPathIssues(file: string, text: string, index: RepoIndex): PathIssue[] {
  const issues: PathIssue[] = [];
  for (const comment of parseSync(file, text).comments) {
    const value = comment.value.replace(URL_PATTERN, (url) => " ".repeat(url.length));
    for (const match of value.matchAll(COMMENT_PATH)) {
      const token = match[0];
      if (!isCheckedToken(token, index) || resolvesInRepo(token, file, index)) continue;
      // comment.value starts after the opening `//` or `/*`.
      issues.push({ file, line: lineAt(text, comment.start + 2 + match.index), path: token });
    }
  }
  return issues;
}

function isCheckedToken(token: string, index: RepoIndex): boolean {
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (token.includes("/")) {
    return index.directoryNames.has(token.slice(0, token.indexOf("/")));
  }
  if (!BARE_MODULE.test(token)) return false;
  return !token.endsWith(".js") || token.slice(0, -".js".length).includes("-");
}

function resolvesInRepo(token: string, file: string, index: RepoIndex): boolean {
  const relative = token.startsWith("./") || token.startsWith("../");
  const path = relative ? posix.join(posix.dirname(file), token) : token;
  return sourceVariants(path).some((variant) =>
    relative ? index.files.has(variant) : index.suffixes.has(variant),
  );
}

// ESM specifiers name the emitted `.js` file; the repo holds its `.ts` or `.tsx` source.
function sourceVariants(path: string): string[] {
  if (!path.endsWith(".js")) return [path];
  const stem = path.slice(0, -".js".length);
  return [path, `${stem}.ts`, `${stem}.tsx`];
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}
