import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  createContainedOutputFile,
  prepareManagedHumanishOutputDirectory,
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/contained-output.js";
import { gitignoreListsRuntime } from "../../run/project.js";
import { plural } from "../../run/text.js";
import { isNodeError } from "../../run/type-guards.js";
import {
  buildPersonas,
  DEFAULT_PERSONA_COUNT,
  DEFAULT_PERSONA_PREFIX,
  DEFAULT_PERSONA_SEED,
  SKIP_TEXT,
  type FieldReport,
  type PersonaBuildErrorCode,
} from "../../study/persona-build.js";
import {
  CWD_OPTION_DESCRIPTION,
  humanError,
  JSON_OPTION_DESCRIPTION,
  parsePositiveInteger,
  wantsJson,
  writeResult,
  type CliIo,
  type HumanOutput,
} from "../io.js";

const PERSONAS_BUILD_SCHEMA = "humanish.personas-build-result.v1";
// A study resolves persona ids only from humanish/personas/ and this folder, so the build writes
// here and nowhere else.
const OUT = path.join(".humanish", "local", "personas");

interface PersonasBuildResult {
  schema: typeof PERSONAS_BUILD_SCHEMA;
  ok: boolean;
  cwd: string;
  sessionsFile: string;
  dryRun: boolean;
  fields: FieldReport[];
  sessions?: { read: number; usable: number };
  sampling?: { drawn: number; seed: number; reused: boolean };
  /** With --dry-run: the first persona file the build would write. */
  preview?: string;
  written: string[];
  roster?: string;
  warnings: string[];
  error?: {
    code:
      | PersonaBuildErrorCode
      | "HUMANISH_PERSONAS_INVALID_OPTION"
      | "HUMANISH_PERSONAS_UNREADABLE_FILE"
      | "HUMANISH_PERSONAS_FILE_EXISTS"
      | "HUMANISH_PERSONAS_TARGET_NOT_FILE"
      | "HUMANISH_PERSONAS_WRITE_FAILED";
    message: string;
  };
}

interface PersonasBuildOptions {
  count?: string;
  seed: string;
  measures?: string;
  habits?: string;
  prefix?: string;
  dryRun?: boolean;
  force?: boolean;
  cwd: string;
}

export function registerPersonasCommands(parent: Command, io: CliIo): void {
  const personas = parent
    .command("personas")
    .description("Build persona files from an export of real sessions.");
  personas
    .command("build")
    .description(
      "Build one persona file per drawn session from an export of real sessions, JSON Lines or one JSON array of flat objects, into .humanish/local/personas/. Only fields whose values are numbers or true and false are read; text, nested values, and fields whose name or values look like an identifier or a time are skipped and listed. Prints the participants block that gives each participant one of the personas.",
    )
    .argument("<sessions-file>", "The export: one session per line, or one JSON array.")
    .option(
      "--count <n>",
      `How many personas to build. Default: every session, up to ${DEFAULT_PERSONA_COUNT}.`,
    )
    .option(
      "--seed <n>",
      "Which sessions are drawn; the same seed draws the same ones.",
      String(DEFAULT_PERSONA_SEED),
    )
    .option(
      "--measures <fields>",
      "Comma-separated fields to read, even ones whose name or values look like an id; the others are skipped.",
    )
    .option(
      "--habits <file>",
      "A humanish.habits.v1 YAML file with your own sentence for each measure.",
    )
    .option("--prefix <id>", "The start of each persona id and file name.", DEFAULT_PERSONA_PREFIX)
    .option("--dry-run", "Print the fields and the first persona, and write nothing.")
    .option("--force", "Replace persona files that are already there.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish personas build sessions.jsonl --dry-run",
        "  humanish personas build sessions.jsonl --count 24",
        "  humanish personas build trips.json --habits habits.yaml --measures stops_added,shared_the_plan",
        "",
        "Run --dry-run first and read what each persona would say. The files hold data from real",
        "sessions and go to .humanish/local/personas/, a folder humanish init adds to .gitignore.",
        "Export no names, emails, ids, timestamps or text people typed.",
      ].join("\n"),
    )
    .action((sessionsFile: string, options: PersonasBuildOptions, command: Command) =>
      handleBuild(io, sessionsFile, options, command),
    );
}

async function handleBuild(
  io: CliIo,
  sessionsFile: string,
  options: PersonasBuildOptions,
  command: Command,
): Promise<void> {
  const result: PersonasBuildResult = {
    schema: PERSONAS_BUILD_SCHEMA,
    ok: false,
    cwd: options.cwd,
    sessionsFile,
    dryRun: options.dryRun === true,
    fields: [],
    written: [],
    warnings: [],
  };
  const finish = (error?: NonNullable<PersonasBuildResult["error"]>): void => {
    if (error) result.error = error;
    result.ok = error === undefined;
    writeResult(command, io, result, formatBuildHuman);
    io.setExitCode(result.ok ? 0 : 2);
  };
  const count = options.count === undefined ? undefined : parsePositiveInteger(options.count);
  const seed = parsePositiveInteger(options.seed);
  if (count === null || seed === null)
    return finish({
      code: "HUMANISH_PERSONAS_INVALID_OPTION",
      message: `${count === null ? "--count" : "--seed"} must be a whole number, 1 or more.`,
    });
  const cwd = path.resolve(options.cwd);
  const read = async (file: string, what: string): Promise<string | undefined> => {
    try {
      return await readFile(path.resolve(cwd, file), "utf8");
    } catch (error) {
      finish({
        code: "HUMANISH_PERSONAS_UNREADABLE_FILE",
        message: `The ${what} ${file} could not be read (${isNodeError(error) ? error.code : "error"}). Check the path; a relative one is read from ${cwd}.`,
      });
      return undefined;
    }
  };
  const sessionsText = await read(sessionsFile, "sessions file");
  if (sessionsText === undefined) return;
  const habitsText =
    options.habits === undefined ? undefined : await read(options.habits, "habits file");
  if (options.habits !== undefined && habitsText === undefined) return;

  const build = buildPersonas({
    sessionsText,
    seed,
    ...(count === undefined ? {} : { count }),
    ...(habitsText === undefined ? {} : { habitsText }),
    ...(options.measures === undefined
      ? {}
      : {
          measures: options.measures
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
  result.fields = build.fields;
  if (build.sessions) result.sessions = build.sessions;
  if (!build.ok) return finish(build.error);
  result.sampling = build.sampling;
  result.warnings.push(...build.warnings);
  if (result.dryRun) {
    result.preview = build.files[0]?.contents ?? "";
    return finish();
  }

  const physical = await realpath(cwd).catch(() => cwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physical), physical);
  if (!(await gitignoreListsRuntime(projectRoot)))
    result.warnings.push(
      `.gitignore does not list .humanish/, so git may pick up these files, which hold data from real sessions. Add .humanish/ to .gitignore, or run humanish init.`,
    );
  const committed = await existing(
    path.join(cwd, "humanish", "personas"),
    build.files.flatMap((file) => [`${file.id}.yaml`, `${file.id}.yml`]),
  );
  if (committed.length > 0)
    result.warnings.push(
      `humanish/personas/ already has ${committed.map(({ name }) => name).join(", ")}, and a study reads that file before the one built here. Pass --prefix to build under other names.`,
    );

  const directory = await prepareManagedHumanishOutputDirectory(physical, "local", "personas");
  const present = await existing(
    directory.physicalPath,
    build.files.map((file) => file.name),
  );
  const notFiles = present.filter(({ file }) => !file);
  if (notFiles.length > 0)
    return finish({
      code: "HUMANISH_PERSONAS_TARGET_NOT_FILE",
      message: `${OUT} has ${notFiles.map(({ name }) => name).join(", ")}, which is not a plain file, so nothing was written. Move it away and build again.`,
    });
  if (present.length > 0 && options.force !== true)
    return finish({
      code: "HUMANISH_PERSONAS_FILE_EXISTS",
      message: `${OUT} already has ${present.map(({ name }) => name).join(", ")}, so nothing was written. Pass --force to replace them, or --prefix to build under other names.`,
    });

  // The fields used and skipped go out before any file is written.
  if (!wantsJson(command)) io.writeOut(formatFields(result));
  for (const file of build.files) {
    try {
      if (options.force === true)
        await writeContainedOutputFile(directory, file.name, file.contents);
      else await createContainedOutputFile(directory, file.name, file.contents);
    } catch (error) {
      const done = result.written.length;
      return finish({
        code: "HUMANISH_PERSONAS_WRITE_FAILED",
        message: `${file.name} could not be written to ${OUT} (${isNodeError(error) ? error.code : (error as Error).message}). ${done === 0 ? "No persona file was written." : `${plural(done, "file")} were written first: ${result.written.join(", ")}.`} Fix the folder and build again with --force.`,
      });
    }
    result.written.push(file.name);
  }
  result.roster = build.roster;
  finish();
}

/** Which of `names` are already in `directory`, and whether each is a plain file. */
async function existing(
  directory: string,
  names: readonly string[],
): Promise<Array<{ name: string; file: boolean }>> {
  const found: Array<{ name: string; file: boolean }> = [];
  for (const name of names) {
    try {
      const stats = await lstat(path.join(directory, name));
      found.push({ name, file: stats.isFile() && stats.nlink === 1 });
    } catch (error) {
      if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
    }
  }
  return found;
}

/** A field name from the export, without the control characters that would move the terminal. */
const printable = (name: string): string => name.replace(/\p{Cc}/gu, "");

function formatFields(result: PersonasBuildResult): string {
  const used = result.fields.flatMap((field) => (field.used ? [field] : []));
  const skipped = result.fields.flatMap((field) => (field.used ? [] : [field]));
  const sessions = result.sessions;
  return (
    [
      ...(sessions
        ? [
            `Read ${plural(sessions.read, "session")} from ${result.sessionsFile}; ${sessions.usable} of them hold at least one measure.`,
          ]
        : []),
      ...(used.length > 0
        ? [
            "Measures each persona states:",
            ...used.map((field) => `  ${printable(field.name)} (${field.kind})`),
          ]
        : []),
      ...(skipped.length > 0
        ? [
            "Skipped, and written to no persona:",
            ...skipped.map((field) => `  ${printable(field.name)}: ${SKIP_TEXT[field.reason]}`),
          ]
        : []),
    ].join("\n") + "\n"
  );
}

function formatBuildHuman(result: PersonasBuildResult): HumanOutput {
  if (!result.ok) {
    const fields = result.sessions ? formatFields(result) : "";
    return fields ? { stdout: fields, error: result.error } : humanError(result.error);
  }
  const sampling = result.sampling!;
  const sessions = result.sessions!;
  const drawn = sampling.reused
    ? `Built ${plural(sampling.drawn, "persona")} from ${plural(sessions.usable, "session")} with seed ${sampling.seed}: there are fewer sessions than --count, so sessions are used more than once.`
    : `Drew ${sampling.drawn} of ${plural(sessions.usable, "session")} with seed ${sampling.seed}.`;
  const warnings = result.warnings.map((warning) => `warning: ${warning}`);
  if (result.dryRun)
    return [
      formatFields(result).trimEnd(),
      drawn,
      ...warnings,
      "Dry run: nothing was written. The first persona would be:",
      "",
      result.preview ?? "",
    ].join("\n");
  const first = result.written[0];
  const last = result.written.at(-1);
  return [
    drawn,
    `Wrote ${plural(result.written.length, "persona file")} to ${OUT}: ${first === last ? first : `${first} to ${last}`}.`,
    ...warnings,
    "Paste this into your study file to give each participant one of them:",
    "",
    result.roster ?? "",
  ].join("\n");
}
