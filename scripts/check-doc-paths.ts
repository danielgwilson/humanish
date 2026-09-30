/** Fails when a doc or a src/ comment names a repo file that does not exist. Run by docs:check. */
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
} from "./lib/doc-paths.js";

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

const docs = paths.filter(isCheckedDoc);
const sources = paths.filter(isCheckedSource);
const issues = [
  ...docs.flatMap((path) => findDocPathIssues(path, read(path), index)),
  ...sources.flatMap((path) => findCommentPathIssues(path, read(path), index)),
];

for (const { file, line, path, resolved } of issues) {
  const target = resolved === undefined ? path : `${path} (${resolved} from this file)`;
  process.stderr.write(`${file}:${line} names ${target}, which does not exist\n`);
}
if (issues.length > 0) {
  process.stderr.write(
    `${issues.length} stale path(s). Point each at the current file or drop the pointer.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Paths resolve in ${docs.length} docs and ${sources.length} src files.\n`);
}
