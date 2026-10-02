// Site pages document the published package, so they link a repository file as `repo:<path>`,
// which site/components/docs/mdx.tsx opens at the release tag. A GitHub link to main would show a
// reader of the published version files that have moved or changed since. Two kinds of file keep
// a main link: dated study records under docs/evidence/, which do not change once written, and
// `SECURITY.md`, whose reporting channel applies to every version.

/** Paths a site page may link on main. */
export const SITE_MAIN_LINKABLE = ["docs/evidence/", "SECURITY.md"];

const REPO_LINK = /\]\(\s*<?repo:([^)\s>#]*)(?:#([^)\s>]*))?>?\s*\)/g;
const MAIN_LINK = /github\.com\/danielgwilson\/humanish\/(?:blob|tree)\/main\/([^\s)"'#<>]+)/g;

export interface RepoLink {
  line: number;
  path: string;
  fragment: string | undefined;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** True for the site's docs pages, which these rules cover. */
export function isSitePage(path: string): boolean {
  return path.startsWith("site/content/") && path.endsWith(".mdx");
}

/** Every `repo:` link on a page, with its 1-based line. */
export function findRepoLinks(text: string): RepoLink[] {
  return [...text.matchAll(REPO_LINK)].map((match) => ({
    line: lineOf(text, match.index),
    path: match[1]!,
    fragment: match[2],
  }));
}

/** The GitHub links to main on a page outside `SITE_MAIN_LINKABLE`, as `line path`. */
export function findMainLinks(text: string): { line: number; path: string }[] {
  return [...text.matchAll(MAIN_LINK)]
    .filter((match) => !SITE_MAIN_LINKABLE.some((allowed) => match[1]!.startsWith(allowed)))
    .map((match) => ({ line: lineOf(text, match.index), path: match[1]! }));
}

/**
 * Why a `repo:` path does not name what it should, or undefined when it does. A folder is written
 * with a trailing `/` and a file without one, because the link opens GitHub's tree or blob view.
 */
export function repoLinkProblem(
  path: string,
  isFile: (path: string) => boolean,
  isDirectory: (path: string) => boolean,
): string | undefined {
  if (path === "") return "names no path";
  if (path.endsWith("/")) {
    return isDirectory(path.slice(0, -1)) ? undefined : "names a folder that does not exist";
  }
  if (isFile(path)) return undefined;
  if (isDirectory(path)) return "names a folder; end it with /";
  return "names a file that does not exist";
}
