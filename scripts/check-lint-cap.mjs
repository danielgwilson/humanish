#!/usr/bin/env node
// Reads oxlint's JSON report on stdin and holds its warning count to the cap in package.json's
// lint script. Any error fails. A warning count above the cap fails, and so does one below it, so
// the PR that removes warnings also lowers the cap. A missing or unreadable report fails too.
import { readFileSync } from "node:fs";

const CAP_FLAG = "--max-warnings=";
const capArg = process.argv.slice(2).find((arg) => arg.startsWith(CAP_FLAG));
const cap = capArg === undefined ? undefined : Number(capArg.slice(CAP_FLAG.length));
if (cap === undefined || !Number.isInteger(cap) || cap < 0) {
  process.stderr.write(`check-lint-cap: pass ${CAP_FLAG}<count>, a whole number.\n`);
  process.exit(2);
}

const input = readFileSync(0, "utf8");
let report;
try {
  report = JSON.parse(input);
} catch {
  process.stdout.write(input);
  process.stderr.write(
    "check-lint-cap: stdin is not an oxlint JSON report (oxlint --format=json).\n",
  );
  process.exit(2);
}
if (!Array.isArray(report?.diagnostics)) {
  process.stderr.write("check-lint-cap: the oxlint report has no diagnostics list.\n");
  process.exit(2);
}

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
