/**
 * Fails when a doc or a src/ comment names a repo file that does not exist, when `ARCHITECTURE.md`'s
 * code map misses a src/ folder or lists one that is gone, when no index links a checked page
 * under docs/, when a checked doc opens a line with `Date:` or `Status:`, when `README.md` or a
 * site page links into docs/history/, or when a site page links a docs/architecture/ page outside
 * `SITE_LINKABLE_ARCHITECTURE`. On a site page, a `repo:` link must name a file or folder that
 * exists here and at the release tag of package.json's version, when that tag is present, and a
 * GitHub link to main must name a path in `SITE_MAIN_LINKABLE`. Run by docs:check.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRepoIndex,
  findCommentPathIssues,
  findDocPathIssues,
  isCheckedDoc,
  isCheckedSource,
  markdownAnchors,
} from "./lib/doc-paths.js";
import { findCodeMapIssues, requiredFolders } from "./lib/code-map.js";
import {
  findMainLinks,
  findRepoLinks,
  isSitePage,
  repoLinkProblem,
} from "./lib/site-repo-links.js";
import {
  citesEvidenceOnly,
  findHistoryLinks,
  findPreambleLines,
  findSiteArchitectureLinks,
  findUnindexedDocs,
} from "./lib/doc-index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Tracked plus untracked-but-not-ignored files, so a file added before `git add` counts, and a
// tracked file deleted from the working tree does not.
const paths = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((path) => path !== "" && existsSync(resolve(root, path)));
const index = buildRepoIndex(paths);
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const anchorCache = new Map<string, Set<string>>();
const anchorsOf = (path: string) => {
  if (!index.files.has(path)) return undefined;
  if (!anchorCache.has(path)) anchorCache.set(path, markdownAnchors(read(path)));
  return anchorCache.get(path);
};

const docs = paths.filter(isCheckedDoc);
const sources = paths.filter(isCheckedSource);
const issues = [
  ...docs.flatMap((path) => findDocPathIssues(path, read(path), index, anchorsOf)),
  ...sources.flatMap((path) => findCommentPathIssues(path, read(path), index)),
];

const sitePages = docs.filter(isSitePage);
const repoLinks = sitePages.flatMap((page) =>
  findRepoLinks(read(page)).map((link) => ({ page, ...link })),
);
const repoLinkIssues = repoLinks.flatMap(({ page, line, path, fragment }) => {
  const problem = repoLinkProblem(
    path,
    (file) => index.files.has(file),
    (folder) => index.directories.has(`${folder}/`),
  );
  if (problem !== undefined) return [`${page}:${line} repo:${path} ${problem}`];
  const anchors = fragment === undefined ? undefined : anchorsOf(path);
  if (anchors && !anchors.has(fragment!))
    return [`${page}:${line} repo:${path} has no #${fragment}`];
  return [];
});
// The tag the site links is the one for package.json's version. A checkout without it (a release
// commit before its tag exists, or a clone without tags) checks the paths here only.
const { version } = JSON.parse(read("package.json")) as { version: string };
const tag = `v${version}`;
const tagPresent =
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: root })
    .status === 0;
if (tagPresent && repoLinks.length > 0) {
  const queries = repoLinks.map(({ path }) => `${tag}:${path.replace(/\/$/, "")}`);
  const answers = execFileSync("git", ["cat-file", "--batch-check"], {
    cwd: root,
    encoding: "utf8",
    input: `${queries.join("\n")}\n`,
  }).split("\n");
  repoLinks.forEach(({ page, line, path }, n) => {
    if (answers[n]?.endsWith(" missing")) {
      repoLinkIssues.push(
        `${page}:${line} repo:${path} does not exist at ${tag}, the version the site documents`,
      );
    }
  });
}
const mainLinkIssues = sitePages.flatMap((page) =>
  findMainLinks(read(page)).map(
    ({ line, path }) => `${page}:${line} links ${path} on main; write repo:${path}`,
  ),
);
for (const issue of [...repoLinkIssues, ...mainLinkIssues]) process.stderr.write(`${issue}\n`);

const codeMapIssues = findCodeMapIssues(read("ARCHITECTURE.md"), paths);
for (const issue of codeMapIssues) process.stderr.write(`${issue}\n`);

const unindexed = findUnindexedDocs(paths, (path) =>
  index.files.has(path) ? read(path) : undefined,
);
// A study record under docs/evidence/ keeps its date line: the date is part of the record.
const preambles = docs
  .filter((path) => !path.startsWith("docs/evidence/"))
  .flatMap((path) => findPreambleLines(read(path)).map((line) => `${path}:${line}`));
for (const at of preambles) {
  process.stderr.write(`${at} opens with Date: or Status:; git log holds dates\n`);
}
const historyLinks = docs
  .filter(citesEvidenceOnly)
  .flatMap((path) => findHistoryLinks(path, read(path)).map((line) => `${path}:${line}`));
for (const at of historyLinks) {
  process.stderr.write(`${at} links into docs/history/; cite docs/evidence/ or a current page\n`);
}
const siteArchitecture = docs.flatMap((path) =>
  findSiteArchitectureLinks(path, read(path)).map((page) => `${path} links ${page}`),
);
for (const link of siteArchitecture) {
  process.stderr.write(
    `${link}; move a user guide onto the site, or list reference in doc-index.ts\n`,
  );
}
for (const path of unindexed) {
  process.stderr.write(
    `${path} is linked from no README.md in its folders, up to docs/README.md\n`,
  );
}

for (const { file, line, path, resolved, anchor } of issues) {
  if (anchor !== undefined) {
    process.stderr.write(
      `${file}:${line} links to #${anchor} in ${resolved}, which has no such heading\n`,
    );
    continue;
  }
  const target = resolved === undefined ? path : `${path} (${resolved} from this file)`;
  process.stderr.write(`${file}:${line} names ${target}, which does not exist\n`);
}
if (issues.length > 0) {
  process.stderr.write(
    `${issues.length} stale path(s). Point each at the current file or drop the pointer.\n`,
  );
}
if (codeMapIssues.length > 0) {
  process.stderr.write(
    `${codeMapIssues.length} code map gap(s). Add or remove the folder's row in ARCHITECTURE.md.\n`,
  );
}
if (unindexed.length > 0) {
  process.stderr.write(
    `${unindexed.length} unindexed page(s). Link each from docs/README.md or a README.md in its folders.\n`,
  );
}
if (preambles.length > 0) {
  process.stderr.write(
    `${preambles.length} preamble line(s). Delete them, keeping a scope sentence where it carries a fact.\n`,
  );
}
if (repoLinkIssues.length + mainLinkIssues.length > 0) {
  process.stderr.write(
    `${repoLinkIssues.length + mainLinkIssues.length} site repository link(s) to fix.\n`,
  );
}
if (siteArchitecture.length > 0) {
  process.stderr.write(`${siteArchitecture.length} site link(s) to a docs/architecture/ page.\n`);
}
if (historyLinks.length > 0) {
  process.stderr.write(`${historyLinks.length} history link(s) from the README or the site.\n`);
}
if (
  issues.length > 0 ||
  codeMapIssues.length > 0 ||
  unindexed.length > 0 ||
  preambles.length > 0 ||
  historyLinks.length > 0 ||
  siteArchitecture.length > 0 ||
  repoLinkIssues.length > 0 ||
  mainLinkIssues.length > 0
) {
  process.exitCode = 1;
} else {
  process.stdout.write(`Paths resolve in ${docs.length} docs and ${sources.length} src files.\n`);
  process.stdout.write(`The code map covers all ${requiredFolders(paths).length} src folders.\n`);
  process.stdout.write("An index links every checked page under docs/, and none has a preamble.\n");
  process.stdout.write("The README and the site cite no page under docs/history/.\n");
  process.stdout.write(
    `Site pages link ${repoLinks.length} repository files at ${tagPresent ? tag : "this checkout (no tag)"}.\n`,
  );
}
