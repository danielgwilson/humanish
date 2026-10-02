/**
 * Fails when a src/ doc comment documents nothing (see lib/orphan-doc-comments.ts), or when a name
 * src/index.ts exports has no doc comment where it is declared (see lib/public-export-docs.ts).
 * Run by docs:check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findOrphanDocComments } from "./lib/orphan-doc-comments.js";
import { findUndocumentedExports } from "./lib/public-export-docs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((path) => path.endsWith(".ts") && existsSync(resolve(root, path)));

let count = 0;
for (const file of files) {
  for (const issue of findOrphanDocComments(readFileSync(resolve(root, file), "utf8"))) {
    count += 1;
    process.stderr.write(`${file}:${issue.line} doc comment ${issue.reason}\n`);
  }
}
if (count > 0) {
  process.stderr.write(
    `${count} doc comment(s) document nothing. Move each onto the symbol it describes, or delete it.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Doc comments attach to a declaration in ${files.length} src files.\n`);
}

const read = (file: string): string | undefined => {
  const path = resolve(root, file);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};
const undocumented = findUndocumentedExports(read);
for (const issue of undocumented) {
  process.stderr.write(`${issue.file}:${issue.line} ${issue.name}: ${issue.reason}\n`);
}
if (undocumented.length > 0) {
  process.stderr.write(
    `${undocumented.length} public export(s) have no doc comment. Write one to three sentences on the declaration: what it is and when an adopter uses it.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Every name src/index.ts exports has a doc comment.\n");
}
