// Every checked page under docs/ is reachable from an index: `docs/README.md`, or the `README.md`
// of one of the folders that hold the page. A page no index links is one a reader cannot find from
// the docs front door. A checked page also carries no `Date:` or `Status:` preamble: git log holds
// the dates, and a status line goes stale while the page around it is kept current.
import { posix } from "node:path";
import { isCheckedDoc } from "./doc-paths.js";

const DOCS_INDEX = "docs/README.md";
// A markdown link target: `[text](target)` or `[text](<target> "title")`.
const MARKDOWN_LINK = /\]\(\s*<?([^()\s<>]+?)>?(?:\s+"[^"]*")?\s*\)/g;

/** The repo paths an index file links to, resolved from the index's folder. */
function linkedPaths(indexPath: string, text: string): Set<string> {
  const linked = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const target = match[1]!.split("#")[0]!.split("?")[0]!;
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    linked.add(posix.normalize(posix.join(posix.dirname(indexPath), target)));
  }
  return linked;
}

/** The `README.md` of each folder from the page's own up to docs/, leaving out the page itself. */
function indexesOf(path: string): string[] {
  const indexes: string[] = [];
  for (let folder = posix.dirname(path); ; folder = posix.dirname(folder)) {
    const index = posix.join(folder, "README.md");
    if (index !== path) indexes.push(index);
    if (folder === "docs" || !folder.startsWith("docs/")) return indexes;
  }
}

/**
 * The checked pages under docs/ that no `README.md` in their folders, up to `docs/README.md`, links.
 * `read` returns a file's text, or undefined when the file does not exist.
 */
export function findUnindexedDocs(
  paths: readonly string[],
  read: (path: string) => string | undefined,
): string[] {
  const cache = new Map<string, Set<string>>();
  const linksOf = (indexPath: string): Set<string> => {
    let linked = cache.get(indexPath);
    if (linked === undefined) {
      const text = read(indexPath);
      linked = text === undefined ? new Set() : linkedPaths(indexPath, text);
      cache.set(indexPath, linked);
    }
    return linked;
  };
  return paths.filter((path) => {
    if (!path.startsWith("docs/") || !isCheckedDoc(path) || path === DOCS_INDEX) return false;
    return !indexesOf(path).some((index) => linksOf(index).has(path));
  });
}

/** The 1-based lines of a page that open with `Date:` or `Status:`. */
export function findPreambleLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (/^(Date|Status):/.test(line)) lines.push(index + 1);
  });
  return lines;
}

/** True for `README.md` and site pages, which cite evidence and never history. */
export function citesEvidenceOnly(path: string): boolean {
  return path === "README.md" || (path.startsWith("site/content/") && path.endsWith(".mdx"));
}

/**
 * The 1-based lines where a page links into docs/history/, by relative link or GitHub URL.
 * `README.md` and the site cite dated results from docs/evidence/, which docs:check covers; history is not
 * maintained, so a claim backed by it can go stale unseen.
 */
export function findHistoryLinks(path: string, text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    const viaUrl = /github\.com\/[\w.-]+\/humanish\/(?:blob|tree)\/main\/docs\/history\//.test(
      line,
    );
    const viaLink = [...line.matchAll(MARKDOWN_LINK)].some((match) => {
      const target = match[1]!.split("#")[0]!;
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
      return posix.normalize(posix.join(posix.dirname(path), target)).startsWith("docs/history/");
    });
    if (viaUrl || viaLink) lines.push(index + 1);
  });
  return lines;
}
