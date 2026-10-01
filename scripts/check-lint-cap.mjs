#!/usr/bin/env node
// Runs oxlint once and holds its warning count to the cap in package.json's lint script. Any
// error fails. A warning count above the cap fails, and so does one below it, so the PR that
// removes warnings also lowers the cap. oxlint runs here, not in a shell pipe, so its exit status
// is checked: a crash, or a failing exit with no error in the report, fails too. Arguments other
// than --max-warnings go to oxlint.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CAP_FLAG = "--max-warnings=";
const args = process.argv.slice(2);
const capArg = args.find((arg) => arg.startsWith(CAP_FLAG));
const cap = capArg === undefined ? undefined : Number(capArg.slice(CAP_FLAG.length));
if (cap === undefined || !Number.isInteger(cap) || cap < 0) {
  process.stderr.write(`check-lint-cap: pass ${CAP_FLAG}<count>, a whole number.\n`);
  process.exit(2);
}

const oxlint = join(
  dirname(createRequire(import.meta.url).resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);
const run = spawnSync(
  process.execPath,
  [oxlint, "--format=json", ...args.filter((arg) => arg !== capArg)],
  { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
);
const fail = (message) => {
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(`check-lint-cap: ${message}\n`);
  process.exit(2);
};
if (run.error) fail(`could not run oxlint: ${run.error.message}`);
if (run.status === null) fail(`oxlint stopped on ${run.signal}.`);

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  fail(`oxlint exited ${run.status} without a JSON report.`);
}
if (!Array.isArray(report?.diagnostics)) fail("the oxlint report has no diagnostics list.");

const counts = { warning: 0, error: 0 };
for (const diagnostic of report.diagnostics) {
  const span = diagnostic.labels?.[0]?.span;
  const at =
    span === undefined ? diagnostic.filename : `${diagnostic.filename}:${span.line}:${span.column}`;
  const help = diagnostic.help ? ` help: ${diagnostic.help}` : "";
  process.stdout.write(
    `${at}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${help}\n`,
  );
  counts[diagnostic.severity === "error" ? "error" : "warning"] += 1;
}
// oxlint exits 1 when it reports an error and 0 otherwise; anything else means it did not finish.
if (run.status !== 0 && !(run.status === 1 && counts.error > 0)) {
  fail(`oxlint exited ${run.status} with ${counts.error} errors in its report.`);
}

const warnings = counts.warning;
process.stdout.write(`\nlint: ${warnings} warnings (cap ${cap}), ${counts.error} errors\n`);
if (counts.error > 0) {
  process.stdout.write("Fix the errors above; the warning cap does not cover errors.\n");
  process.exitCode = 1;
} else if (warnings > cap) {
  process.stdout.write(
    `The warning count rose by ${warnings - cap}. Fix the new warnings above; the cap only goes down.\n`,
  );
  process.exitCode = 1;
} else if (warnings < cap) {
  process.stdout.write(
    `The warning count fell by ${cap - warnings}. Lower --max-warnings in package.json's lint script to ${warnings} in this PR.\n`,
  );
  process.exitCode = 1;
}
