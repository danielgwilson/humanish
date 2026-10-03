// The one runner. `run` and `watch` register a run's flags through addRunOptions, so the two
// commands cannot drift apart, and the hidden `lab run` alias calls handleRun.
import type { Command } from "commander";
import { runDryRun } from "../../run/dry-run.js";
import type { RunResult } from "../../run/results.js";
import { runLabCommand } from "./lab-run.js";
import {
  applyEnvFileOption,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  ENV_FILE_OPTION_DESCRIPTION,
  formatRunHuman,
  freePortOption,
  JSON_OPTION_DESCRIPTION,
  type LabCommandOptions as RunOptions,
  parsePositiveInteger,
  writeResult,
} from "../io.js";

/** The parsed flags of `run`, `watch` and the `lab run` alias. */
export type { RunOptions };

/** The flags a run takes, whichever command starts it. */
export function addRunOptions(command: Command): Command {
  return command
    .option("--dry-run", "Do a dry run: a synthetic run with no browser, keys or provider spend.")
    .option("--open", "Open the Observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without an attached watch server.")
    .addOption(freePortOption())
    .option(
      "--count <count>",
      "Override the participant count of a preview or computer-use study, or of the synthetic run without a study.",
    )
    .option(
      "--rerun-failed-from <run>",
      "Computer-use studies only: start a new run for the failed participants of a prior run.",
    )
    .option(
      "--participants <ids>",
      "With --rerun-failed-from: comma-separated ids of the participants to rerun. The study's participants decide who takes part; ids are their id, or lane-01, lane-02, … by position.",
    )
    .option(
      "--scorer <path>",
      "Score with this .mjs module, a path inside the repo, in place of review.scorer.ref. It runs as code, so review it first. Terminal, computer-use and shared-world studies only.",
    )
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--env-file <path>", ENV_FILE_OPTION_DESCRIPTION)
    .option(
      "--run-id <id>",
      "Explicit run id for deterministic fixture tests; refused when that run already exists.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION);
}

/** The flags that only a study file can use, as typed on the command line, when they are set. */
export function studyOnlyFlags(options: RunOptions): string[] {
  return [
    options.scorer === undefined ? [] : ["--scorer"],
    options.rerunFailedFrom === undefined ? [] : ["--rerun-failed-from"],
    options.participants === undefined ? [] : ["--participants"],
  ].flat();
}

function refuseRun(command: Command, io: CliIo, cwd: string, error: RunResult["error"]): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd,
    warnings: [],
    ...(error === undefined ? {} : { error }),
  };
  writeResult(command, io, result, formatRunHuman);
  io.setExitCode(2);
}

/** `humanish run [study]`: the named study, or the synthetic preview when no study is given. */
export async function handleRun(
  io: CliIo,
  named: string | undefined,
  options: RunOptions,
  command: Command,
): Promise<void> {
  // An empty argument, as from a script passing an unset variable, is the synthetic run.
  const study = named === "" ? undefined : named;
  const studyOnly = studyOnlyFlags(options);
  if (study === undefined && studyOnly.length > 0) {
    refuseRun(command, io, options.cwd, {
      code: "HUMANISH_RUN_OPTION_CONFLICT",
      message: `${studyOnly.join(", ")} ${studyOnly.length === 1 ? "needs" : "need"} a study: humanish run <study>.`,
    });
    return;
  }
  const loaded = await applyEnvFileOption({
    command,
    cwd: options.cwd,
    envFile: options.envFile,
    io,
    // runLabCommand discovers keys for a live lab; the lab-less preview needs none.
    discoverKeys: false,
  });
  if (!loaded) return;

  if (study !== undefined) {
    await runLabCommand({ command, io, lab: study, mode: "run", options });
    return;
  }

  const participantCount =
    options.count === undefined ? undefined : parsePositiveInteger(options.count);
  if (participantCount === null) {
    refuseRun(command, io, options.cwd, {
      code: "HUMANISH_INVALID_PARTICIPANT_COUNT",
      message: "--count must be a positive integer.",
    });
    return;
  }

  const result = await runDryRun({
    cwd: options.cwd,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(participantCount === undefined ? {} : { participantCount }),
    // Rendered the way `watch` renders it, so a bundle is the same bundle whichever command
    // produced it. A render failure is a warning on the result.
    observer: { open: false },
  });
  writeResult(command, io, result, formatRunHuman);
  io.setExitCode(result.ok ? 0 : 2);
}
