import type { Command } from "commander";

import { migrateStudies, type MigrateFile, type MigrateResult } from "../../study/migrate.js";
import {
  CWD_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  wantsJson,
  writeResult,
  type CliIo,
} from "../io.js";

function formatValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Each file's source, destination, moved keys and dropped keys, printed before any write. */
function formatMigratePlan(files: readonly MigrateFile[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (file.action === "skip") {
      lines.push(`${file.source}: already humanish.study.v3, skipped`);
      continue;
    }
    const where = file.action === "move" ? `-> ${file.destination}` : "(rewritten in place)";
    lines.push(`${file.source} ${where} (route: ${file.route})`);
    if (file.moved.length > 0)
      lines.push(`  moved: ${file.moved.map((key) => `${key.from} -> ${key.to}`).join(", ")}`);
    for (const key of file.dropped) {
      lines.push(
        `  dropped ${key.path}: ${formatValue(key.value)} (the ${file.route} route never reads it)`,
      );
      if (key.comments) lines.push(`    its comment: ${key.comments.replace(/\n/g, " ")}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "No study files to convert.\n";
}

function formatMigrateOutcome(result: MigrateResult): string {
  if (result.error) {
    const where = result.error.file ? ` ${result.error.file}` : "";
    return `${result.error.code} (${result.error.phase})${where}: ${result.error.message}\n`;
  }
  const written = result.files.filter((file) => file.action !== "skip").length;
  const files = written === 1 ? "1 study file" : `${written} study files`;
  if (result.dryRun) return `Dry run: nothing was written. ${files} would change.\n`;
  return written === 0 ? "No v2 study files to convert.\n" : `Converted ${files}.\n`;
}

/** `humanish migrate`. */
export function registerMigrateCommand(parent: Command, io: CliIo): void {
  parent
    .command("migrate")
    .description(
      "Convert humanish.lab.v2 study files to humanish.study.v3. A file under a labs/ directory moves to the matching studies/ directory; any other file is rewritten in place. An original that a failure leaves out of place is kept as <name>.v2.bak. Pass the files to convert; without any, the six study directories are scanned. Every destination, moved key and dropped key is printed before anything is written. A file that changes during the run is kept and listed.",
    )
    .summary("Convert v2 study files to v3.")
    // The paths are read from the command's arguments without a declared argument, so the root
    // --help row stays `migrate [options]` and fits its column; this command's own help shows them.
    .usage("[options] [path...]")
    .allowExcessArguments(true)
    .option("--dry-run", "Print what would change and write nothing.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (options: { cwd: string; dryRun?: boolean; json?: boolean }, command: Command) => {
        const paths = command.args;
        const json = wantsJson(command);
        const result = await migrateStudies({
          cwd: options.cwd,
          paths,
          dryRun: options.dryRun === true,
          // The plan is printed before anything is written; with --json it goes to stderr, so stdout
          // stays one JSON document.
          onPlan: (files) => (json ? io.writeErr : io.writeOut)(formatMigratePlan(files)),
        });
        writeResult(command, io, result, formatMigrateOutcome);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}
