/**
 * Fails when a doc pairs a code name with a file that no longer declares it (see
 * lib/doc-symbols.ts). Run by docs:check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCheckedDoc } from "./lib/doc-paths.js";
import { findDocSymbolIssues, findSymbolReferences } from "./lib/doc-symbols.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((path) => path !== "" && existsSync(resolve(root, path)));
const files = new Set(paths);
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readSource = (path: string) => (files.has(path) ? read(path) : undefined);

const docs = paths.filter(isCheckedDoc);
const cache = new Map();
let references = 0;
const issues = docs.flatMap((doc) => {
  const text = read(doc);
  references += findSymbolReferences(text).length;
  return findDocSymbolIssues(doc, text, readSource, cache);
});
for (const { file, line, name, path } of issues) {
  process.stderr.write(`${file}:${line} names \`${name}\` in ${path}, which does not declare it\n`);
}
if (issues.length > 0) {
  process.stderr.write(
    `${issues.length} stale symbol reference(s). Point each at the file that declares the name, or rename it.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${references} symbol references resolve in their files.\n`);
}
