/**
 * Fails when a doc or a src/ comment names a repo file that does not exist, when ARCHITECTURE.md's
 * code map misses a src/ folder or lists one that is gone, when no index links a checked page
 * under docs/, or when a checked doc opens a line with `Date:` or `Status:`. Run by docs:check.
 */
import { execFileSync } from "node:child_process";
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
import { findPreambleLines, findUnindexedDocs } from "./lib/doc-index.js";

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

const codeMapIssues = findCodeMapIssues(read("ARCHITECTURE.md"), paths);
for (const issue of codeMapIssues) process.stderr.write(`${issue}\n`);

const unindexed = findUnindexedDocs(paths, (path) =>
  index.files.has(path) ? read(path) : undefined,
);
const preambles = docs.flatMap((path) =>
  findPreambleLines(read(path)).map((line) => `${path}:${line}`),
);
for (const at of preambles) {
  process.stderr.write(`${at} opens with Date: or Status:; git log holds dates\n`);
}
for (const path of unindexed) {
  process.stderr.write(
    `${path} is linked from neither docs/README.md nor its folder's README.md\n`,
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
    `${unindexed.length} unindexed page(s). Link each from docs/README.md or its folder's README.md.\n`,
  );
}
if (preambles.length > 0) {
  process.stderr.write(
    `${preambles.length} preamble line(s). Delete them, keeping a scope sentence where it carries a fact.\n`,
  );
}
if (issues.length > 0 || codeMapIssues.length > 0 || unindexed.length > 0 || preambles.length > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write(`Paths resolve in ${docs.length} docs and ${sources.length} src files.\n`);
  process.stdout.write(`The code map covers all ${requiredFolders(paths).length} src folders.\n`);
  process.stdout.write("An index links every checked page under docs/, and none has a preamble.\n");
}
