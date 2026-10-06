/**
 * `pnpm arch:bench`: measures depth, seams, the interface as test surface and locality over src/,
 * tests/ and main's history. docs/evidence/architecture/README.md defines every number and its
 * limits. A report, so it is in neither `pnpm check` nor CI.
 *
 *   pnpm arch:bench                       print the tables
 *   pnpm arch:bench --json                print the result as JSON
 *   pnpm arch:bench --out docs/evidence/architecture
 *                                         write <date>-<head>.json and .md there
 *
 * --since <date> (a UTC day such as 2026-09-29, the default) and --ref <ref> (default
 * origin/main) set the history window; --max-lines <n> (default 40) sets the deletion-test size
 * limit.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { version as typescriptVersion } from "typescript";
import {
  measureLocality,
  measureRoutes,
  readCommits,
  readCommitsSince,
  resolveCommit,
  type RouteBaseline,
} from "./lib/arch-bench-history.js";
import { measureArchitecture } from "./lib/arch-bench-measure.js";
import { readProjectFacts } from "./lib/arch-bench-project.js";
import { renderMarkdown, renderText, type ArchBenchResult } from "./lib/arch-bench-report.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "2026-09-29" },
    ref: { type: "string", default: "origin/main" },
    "max-lines": { type: "string", default: "40" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const maxLines = Number(values["max-lines"]);
if (!Number.isInteger(maxLines) || maxLines < 1) {
  process.stderr.write("arch:bench: --max-lines takes a whole number of at least 1.\n");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
  process.stderr.write("arch:bench: --since takes a date as YYYY-MM-DD.\n");
  process.exit(2);
}

const baseline = JSON.parse(
  readFileSync(join(root, "scripts/lib/arch-bench-route-commits.json"), "utf8"),
) as RouteBaseline;
const window = readCommitsSince(root, values.ref, values.since);
const result: ArchBenchResult = {
  schema: "humanish.arch-bench.v1",
  createdAt: new Date().toISOString(),
  source: {
    head: resolveCommit(root, "HEAD"),
    dirty:
      execFileSync("git", ["status", "--porcelain", "--", "src", "tests", "tsconfig.json"], {
        cwd: root,
        encoding: "utf8",
      }).trim() !== "",
    typescript: typescriptVersion,
  },
  options: { maxLines },
  ...measureArchitecture(readProjectFacts(root), { maxLines }),
  history: {
    ref: values.ref,
    refCommit: resolveCommit(root, values.ref),
    since: values.since,
    locality: measureLocality(window),
    routes: measureRoutes(
      window,
      baseline,
      readCommits(
        root,
        baseline.commits.map((entry) => entry.commit),
      ),
    ),
  },
};

if (values.out !== undefined) {
  const directory = resolve(values.out);
  mkdirSync(directory, { recursive: true });
  const name = `${result.createdAt.slice(0, 10)}-${result.source.head}`;
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(directory, `${name}.md`), renderMarkdown(result, `${name}.json`));
  process.stdout.write(`Wrote ${name}.json and ${name}.md to ${directory}.\n`);
} else if (values.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(renderText(result));
}
