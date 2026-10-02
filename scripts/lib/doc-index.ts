// Every checked page under docs/ is reachable from an index: docs/README.md, or the README.md of
// the page's own folder. A page no index links is one a reader cannot find from the docs front
// door. A checked page also carries no `Date:` or
// `Status:` preamble: git log holds the dates, and a status line goes stale while the page around
// it is kept current.
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

/**
 * The checked pages under docs/ that neither docs/README.md nor their folder's README.md links.
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
    if (linksOf(DOCS_INDEX).has(path)) return false;
    const folderIndex = posix.join(posix.dirname(path), "README.md");
    return folderIndex === path || !linksOf(folderIndex).has(path);
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
