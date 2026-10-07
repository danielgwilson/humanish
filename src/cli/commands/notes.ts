import type { Command } from "commander";

import { renderObserver } from "../../observer/render.js";
import { resolveRunPath } from "../../run/locate.js";
import {
  addRunNote,
  formatRunTime,
  readRunNotes,
  type RunNote,
  type RunNoteErrorCode,
} from "../../run/notes.js";
import { resolvePhysicalCwd, runIdOf } from "../../run/paths.js";
import { runNotFoundMessage } from "../../run/run-not-found.js";
import { cli } from "../invocation.js";
import {
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  humanError,
  JSON_OPTION_DESCRIPTION,
  writeResult,
  type HumanOutput,
} from "../io.js";

const NOTES_RESULT_SCHEMA = "humanish.notes-result.v1";

interface NotesResult {
  schema: typeof NOTES_RESULT_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  /** Every note on the run, in run clock order. */
  notes: RunNote[];
  added?: RunNote;
  warnings: string[];
  error?: {
    code:
      | RunNoteErrorCode
      | "HUMANISH_RUN_NOT_FOUND"
      | "HUMANISH_NOTE_INVALID_TIME"
      | "HUMANISH_NOTES_OPTION_CONFLICT";
    message: string;
  };
}

interface NotesOptions {
  add?: boolean;
  at?: string;
  participant?: string;
  cwd: string;
}

export function registerNotesCommand(parent: Command, io: CliIo): void {
  parent
    .command("notes")
    .description(
      "List the reviewer notes on a run, or add one at a moment of its recording. A note's time counts from the run's first timed capture, as the Observer's study timeline shows it.",
    )
    .summary("List or add reviewer notes on a run.")
    // The text is read from the words after the run, not declared, so the root command list
    // stays as narrow as its other rows and an unquoted note still arrives whole.
    .usage("[options] <run> [text...]")
    .argument("<run>", "Run id, or latest.")
    .allowExcessArguments(true)
    .option("--add", "Add a note. Its text is the words after the run; --at gives the moment.")
    .option("--at <mm:ss>", "With --add: the moment, in minutes and seconds, such as 02:31.")
    .option(
      "--participant <id>",
      "With --add: the participant's stream id. Leave it out for a note on the whole run.",
    )
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish notes latest",
        '  humanish notes latest --add --at 02:31 "The save button was hidden here."',
        '  humanish notes <runId> --add --at 00:45 --participant <id> "They gave up."',
        "",
        "Notes are saved in the run directory as notes.json. Text that looks like a secret or a",
        "local path is replaced before it is saved, and verify scans notes like other run text.",
      ].join("\n"),
    )
    .action((run: string, options: NotesOptions, command: Command) => {
      const words = command.args.slice(1);
      return handleNotes(io, run, words.length > 0 ? words.join(" ") : undefined, options, command);
    });
}

/** Minutes and seconds as the Observer shows them, `02:31`, in milliseconds; null otherwise. */
function parseRunTime(value: string): number | null {
  const match = /^(\d{1,4}):([0-5]\d)$/.exec(value.trim());
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null;
}

const byRunTime = (notes: readonly RunNote[]): RunNote[] =>
  [...notes].sort(
    (left, right) => left.atMs - right.atMs || left.createdAt.localeCompare(right.createdAt),
  );

async function handleNotes(
  io: CliIo,
  run: string,
  text: string | undefined,
  options: NotesOptions,
  command: Command,
): Promise<void> {
  const base = { schema: NOTES_RESULT_SCHEMA, cwd: options.cwd, run, notes: [], warnings: [] };
  const fail = (code: NonNullable<NotesResult["error"]>["code"], message: string): void => {
    writeResult(command, io, { ...base, ok: false, error: { code, message } }, formatNotesHuman);
    io.setExitCode(2);
  };
  const adding = options.add === true;
  if (!adding && (text !== undefined || options.at !== undefined))
    return fail(
      "HUMANISH_NOTES_OPTION_CONFLICT",
      `Adding a note needs --add: ${cli(`notes ${run} --add --at 02:31 "text"`)}.`,
    );
  if (adding && (options.at === undefined || text === undefined))
    return fail(
      "HUMANISH_NOTES_OPTION_CONFLICT",
      `--add needs --at and the note's text: ${cli(`notes ${run} --add --at 02:31 "text"`)}.`,
    );
  const atMs = options.at === undefined ? null : parseRunTime(options.at);
  if (adding && atMs === null)
    return fail(
      "HUMANISH_NOTE_INVALID_TIME",
      `--at ${options.at ?? ""} is not a time on the run clock. Give minutes and seconds from the run's first capture, as the Observer shows them, such as 02:31.`,
    );

  const cwd = await resolvePhysicalCwd(options.cwd);
  const prepared = await resolveRunPath(cwd, run).catch(() => null);
  if (!prepared) return fail("HUMANISH_RUN_NOT_FOUND", await runNotFoundMessage(cwd, run));
  const runId = runIdOf(prepared);

  let added: RunNote | undefined;
  const warnings: string[] = [];
  if (adding && atMs !== null && text !== undefined) {
    const result = await addRunNote(prepared, {
      atMs,
      participant: options.participant ?? null,
      text,
    });
    if (!result.ok) return fail(result.error.code, result.error.message);
    added = result.note;
    if (result.scrubbed)
      warnings.push(
        "Part of the note looked like a secret or a local path, so it was replaced before the note was saved.",
      );
    // The saved Observer page shows notes read-only, so it is rendered again with the new one.
    const rendered = await renderObserver(cwd, runId, { open: false, expectedRun: prepared })
      .then((observer) => observer.ok)
      .catch(() => false);
    if (!rendered)
      warnings.push(
        `The note is saved, but the run's saved Observer page could not be rendered again. ${cli(`observe --run ${runId}`)} shows it.`,
      );
  }

  let notes;
  try {
    notes = await readRunNotes(prepared);
  } catch {
    return fail(
      "HUMANISH_NOTES_UNREADABLE",
      `The notes.json in run ${runId} is not a notes file humanish can read. Move it out of the run directory to start a new one.`,
    );
  }
  const result: NotesResult = {
    ...base,
    ok: true,
    run: runId,
    notes: byRunTime(notes?.notes ?? []),
    ...(added === undefined ? {} : { added }),
    warnings,
  };
  writeResult(command, io, result, formatNotesHuman);
  io.setExitCode(0);
}

function noteLine(note: RunNote, width: number): string {
  const head = `  ${formatRunTime(note.atMs)}  ${(note.participant ?? "whole run").padEnd(width)}  `;
  const [first = "", ...rest] = note.text.split("\n");
  return [`${head}${note.author}: ${first}`, ...rest.map((line) => `         ${line}`)].join("\n");
}

function formatNotesHuman(result: NotesResult): HumanOutput {
  if (!result.ok) return humanError(result.error);
  const warnings = result.warnings.map((warning) => `warning: ${warning}\n`).join("");
  if (result.added)
    return `Added a note at ${formatRunTime(result.added.atMs)} ${result.added.participant === null ? "on the whole run" : `for ${result.added.participant}`} to run ${result.run}. The Observer marks it on the study timeline, and ${cli(`notes ${result.run}`)} lists every note.\n${warnings}`;
  if (result.notes.length === 0)
    return `Run ${result.run} has no reviewer notes. Add one: ${cli(`notes ${result.run} --add --at 00:30 "text"`)}\n${warnings}`;
  const width = Math.max(...result.notes.map((note) => (note.participant ?? "whole run").length));
  return `${[`Reviewer notes on run ${result.run}: ${result.notes.length}`, ...result.notes.map((note) => noteLine(note, width))].join("\n")}\n${warnings}`;
}
