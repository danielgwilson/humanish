import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  createContainedOutputFile,
  prepareManagedHumanishOutputDirectory,
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
  type PreparedSelectedOutputDirectory,
} from "../../run/contained-output.js";
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
  wantsJson,
  writeResult,
  type CliIo,
  type HumanOutput,
} from "../io.js";

const PERSONAS_BUILD_SCHEMA = "humanish.personas-build-result.v1";
const DEFAULT_OUT = path.join(".humanish", "local", "personas");

interface PersonasBuildResult {
  schema: typeof PERSONAS_BUILD_SCHEMA;
  ok: boolean;
  cwd: string;
  sessionsFile: string;
  fields: FieldReport[];
  sessions?: { read: number; usable: number };
  sampling?: { drawn: number; seed: number; reused: boolean };
  /** The directory the files went to, as given or by default. */
  out?: string;
  written: string[];
  roster?: string;
  warnings: string[];
  error?: {
    code:
      | PersonaBuildErrorCode
      | "HUMANISH_PERSONAS_UNREADABLE_FILE"
      | "HUMANISH_PERSONAS_FILE_EXISTS";
    message: string;
  };
}

interface PersonasBuildOptions {
  count?: string;
  seed?: string;
  measures?: string;
  habits?: string;
  prefix?: string;
  out?: string;
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
      "Build one persona file per drawn session from an export of real sessions, JSON Lines or one JSON array of flat objects. Only fields whose values are numbers or true and false are read; text, nested values and fields named like an identifier or a time are skipped and listed. Prints the participants block that gives each participant one of the personas.",
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
    .option("--measures <fields>", "Comma-separated fields to read; the others are skipped.")
    .option(
      "--habits <file>",
      "A humanish.habits.v1 YAML file with your own sentence for each measure.",
    )
    .option("--prefix <id>", "The start of each persona id and file name.", DEFAULT_PERSONA_PREFIX)
    .option("--out <dir>", "Where to write the files.", DEFAULT_OUT)
    .option("--force", "Replace persona files that are already there.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish personas build sessions.jsonl --count 24",
        "  humanish personas build sessions.json --habits habits.yaml --measures rounds_played,used_a_hint",
        "",
        "The default folder, .humanish/local/personas/, is one git ignores, and a study finds its",
        "personas there by id. Export no names, emails, ids, timestamps or text people typed.",
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

  const whole = (value: string | undefined) =>
    value === undefined ? undefined : /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  const build = buildPersonas({
    sessionsText,
    ...(habitsText === undefined ? {} : { habitsText }),
    ...(options.count === undefined ? {} : { count: whole(options.count)! }),
    ...(options.seed === undefined ? {} : { seed: whole(options.seed)! }),
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
  if (!build.ok) return finish({ code: build.error.code, message: build.error.message });
  result.sessions = build.sessions;
  result.sampling = build.sampling;
  result.warnings.push(...build.warnings);

  const out = options.out ?? DEFAULT_OUT;
  result.out = out;
  let directory: PreparedSelectedOutputDirectory;
  try {
    const physical = await realpath(cwd);
    directory =
      out === DEFAULT_OUT
        ? await prepareManagedHumanishOutputDirectory(physical, "local", "personas")
        : await prepareSelectedOutputDirectory(physical, out);
  } catch (error) {
    return finish({
      code: "HUMANISH_PERSONAS_UNREADABLE_FILE",
      message: `The folder ${out} could not be prepared for the persona files: ${(error as Error).message}`,
    });
  }
  const present = await existing(
    directory.physicalPath,
    build.files.map((file) => file.name),
  );
  if (present.length > 0 && options.force !== true)
    return finish({
      code: "HUMANISH_PERSONAS_FILE_EXISTS",
      message: `${out} already has ${present.join(", ")}, so nothing was written. Pass --force to replace them, or --prefix to build under other names.`,
    });
  if (out === DEFAULT_OUT) {
    const committed = path.join(cwd, "humanish", "personas");
    const shadowed = await existing(
      committed,
      build.files.flatMap((file) => [`${file.id}.yaml`, `${file.id}.yml`]),
    );
    if (shadowed.length > 0)
      result.warnings.push(
        `humanish/personas/ already has ${shadowed.join(", ")}, and a study reads that file before the one built here. Pass --prefix to build under other names.`,
      );
  }

  // The fields used and skipped go out before any file is written.
  if (!wantsJson(command)) io.writeOut(formatFields(result));
  for (const file of build.files) {
    if (options.force === true) await writeContainedOutputFile(directory, file.name, file.contents);
    else await createContainedOutputFile(directory, file.name, file.contents);
    result.written.push(file.name);
  }
  result.roster = build.roster;
  finish();
}

/** The names in `names` that are already in `directory`. */
async function existing(directory: string, names: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    try {
      await lstat(path.join(directory, name));
      found.push(name);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return found;
}

function formatFields(result: PersonasBuildResult): string {
  const used = result.fields.flatMap((field) => (field.used ? [field] : []));
  const skipped = result.fields.flatMap((field) => (field.used ? [] : [field]));
  return (
    [
      `Read ${plural(result.sessions?.read ?? 0, "session")} from ${result.sessionsFile}; ${result.sessions?.usable ?? 0} have at least one measure.`,
      "Measures each persona states:",
      ...used.map((field) => `  ${field.name} (${field.kind})`),
      ...(skipped.length > 0
        ? [
            "Skipped, and written to no persona:",
            ...skipped.map((field) => `  ${field.name}: ${SKIP_TEXT[field.reason]}`),
          ]
        : []),
    ].join("\n") + "\n"
  );
}

function formatBuildHuman(result: PersonasBuildResult): HumanOutput {
  if (!result.ok) {
    const fields = result.fields.length > 0 ? formatFields(result) : "";
    return fields ? { stdout: fields, error: result.error } : humanError(result.error);
  }
  const sampling = result.sampling!;
  const sessions = result.sessions!;
  const first = result.written[0];
  const last = result.written.at(-1);
  return [
    sampling.reused
      ? `Built ${plural(sampling.drawn, "persona")} from ${plural(sessions.usable, "session")} with seed ${sampling.seed}: there are fewer sessions than --count, so sessions are used more than once.`
      : `Drew ${sampling.drawn} of ${sessions.usable} sessions with seed ${sampling.seed}.`,
    `Wrote ${plural(result.written.length, "persona file")} to ${result.out}: ${first === last ? first : `${first} to ${last}`}.`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
    "Paste this into your study file to give each participant one of them:",
    "",
    result.roster ?? "",
  ].join("\n");
}
