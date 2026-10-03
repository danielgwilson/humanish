import {
  automaticAnalysisSucceeded,
  defaultAnalysisOverBudget,
  type AutomaticAnalysisResult,
} from "../analysis/automatic-completion.js";
import { DEFAULT_ANALYSIS_MAX_COST_USD } from "../analysis/automatic-config.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { loadEnvFile } from "../keys/env-file.js";
import { discoverProviderKeys } from "../keys/key-resolution.js";
import type { EnvFileLoadResult } from "../keys/env-file.js";
import { deriveRunFacts, type TelemetryProperties } from "./telemetry.js";
import { withQueuedWarnings } from "./deprecations.js";
import { forTerminal } from "../routes/terminal/encoding.js";
import type { RunResult } from "../run/results.js";

export const CLI_RESPONSE_SCHEMA = "humanish.cli-response.v1";

function readCliVersion(): string {
  const packageJsonPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "package.json",
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version
    : "0.0.0";
}

export const CLI_VERSION = readCliVersion();

export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  setExitCode(code: number): void;
  // Injectable for hermetic CLI tests; defaults to discoverProviderKeys.
  keyDiscovery?: typeof discoverProviderKeys;
}

// One text per shared flag, so the same flag reads the same on every command.
// tests/cli/shared-options.test.ts walks the program and holds every use to these.
export const JSON_OPTION_DESCRIPTION = "Print a machine-readable JSON response.";
export const CWD_OPTION_DESCRIPTION = "Project directory.";
export const RUN_OPTION_DESCRIPTION = "Run id, or latest.";
export const ENV_FILE_OPTION_DESCRIPTION =
  "Load unset variables from this env file. Values are never printed or saved.";
export const PORT_OPTION_DESCRIPTION = "Port to listen on at 127.0.0.1.";

/** `--port` for a loopback server whose default, 0, lets the OS pick a free port. */
export function freePortOption(): Option {
  return new Option("--port <port>", PORT_OPTION_DESCRIPTION).default("0", "a free port");
}

export interface LabCommandOptions {
  count?: string | undefined;
  cwd: string;
  detach?: boolean | undefined;
  dryRun?: boolean | undefined;
  envFile?: string | undefined;
  json?: boolean | undefined;
  open?: boolean | undefined;
  participants?: string | undefined;
  port?: string | undefined;
  rerunFailedFrom?: string | undefined;
  runId?: string | undefined;
  /** Repo-relative path to an adopter scorer module; overrides review.scorer.ref when set. */
  scorer?: string | undefined;
  // watch --expose surface (tunnel-edge auth). Only the computer-use route live-serves a run; other
  // backends refuse exposure. See prepareCuaWatch + validateExposure.
  expose?: boolean | undefined;
  tunnel?: "ngrok" | undefined;
  tunnelDomain?: string | undefined;
  oauth?: "google" | undefined;
  allowEmail?: string[] | undefined;
  allowDomain?: string[] | undefined;
  publicUrl?: string | undefined;
  safe?: boolean | undefined;
}

// Transcode only for a terminal. A pipe carries bytes to another program, and mangling those would
// corrupt a JSON payload for a reader that handles UTF-8 perfectly well, while a TTY carries them
// to a font, through a locale that may not decode them. See src/routes/terminal/encoding.ts for what a
// participant actually read back off the screen.
const forStream = (stream: NodeJS.WriteStream, text: string): string =>
  stream.isTTY === true ? forTerminal(text) : text;

export const defaultIo: CliIo = {
  writeOut: (text) => process.stdout.write(forStream(process.stdout, text)),
  writeErr: (text) => process.stderr.write(forStream(process.stderr, text)),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

// Fix set point 1 (general guard): writeResult marks its own invocation's root
// command the moment it flushes a result to stdout. Keyed by the root Command
// of the invocation (a fresh object every createProgram() call) rather than a
// module-level boolean, so tests that construct multiple `createProgram()`
// instances in the same process never see one instance's writes bleed into
// another's, and nothing needs explicit cleanup: the entry is released once
// that Command tree is garbage collected.
const invocationEnvelopeWritten = new WeakSet<Command>();

function rootCommandOf(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

export function markInvocationEnvelopeWritten(command: Command): void {
  invocationEnvelopeWritten.add(rootCommandOf(command));
}

export function invocationEnvelopeAlreadyWritten(command: Command): boolean {
  return invocationEnvelopeWritten.has(rootCommandOf(command));
}

export async function applyEnvFileOption(args: {
  command: Command;
  cwd: string;
  envFile?: string | undefined;
  io: CliIo;
  env?: NodeJS.ProcessEnv;
  onDiscovered?: (names: string[]) => void;
  /** False for the lab-running commands, which discover only once the lab resolves to live. */
  discoverKeys?: boolean;
}): Promise<boolean> {
  const env = args.env ?? process.env;
  if (args.envFile) {
    const stagedEnv = { ...env };
    const result = await loadEnvFile(args.cwd, args.envFile, stagedEnv);
    if (!result.ok) {
      writeResult(args.command, args.io, result, formatEnvFileHuman);
      args.io.setExitCode(2);
      return false;
    }
    for (const name of result.loaded) env[name] = stagedEnv[name];
  }

  if (args.discoverKeys !== false) {
    await discoverCliKeys({
      io: args.io,
      cwd: args.cwd,
      env,
      ...(args.onDiscovered === undefined ? {} : { onDiscovered: args.onDiscovered }),
    });
  }
  return true;
}

/**
 * Provider-key discovery: fill still-missing keys from the documented project overlay, the
 * owning vendors' native stores, and the humanish user store. It is fill-only (an explicit
 * --env-file or process env always wins), and each fill is announced by name and source on
 * stderr, never by value. HUMANISH_STRICT_KEYS=1 restores env-only behavior.
 */
export async function discoverCliKeys(args: {
  io: CliIo;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onDiscovered?: (names: string[]) => void;
  /** Announce only the fills of these names; every key is still filled. Undefined announces all. */
  announced?: ReadonlySet<string>;
}): Promise<void> {
  try {
    const discover = args.io.keyDiscovery ?? discoverProviderKeys;
    const discovered = await discover({
      cwd: args.cwd,
      env: args.env ?? process.env,
      announce: (line) => args.io.writeErr(`${line}\n`),
      ...(args.announced === undefined ? {} : { announced: args.announced }),
    });
    args.onDiscovered?.(discovered.map((fill) => fill.name));
  } catch {
    // Discovery must never break a command; a rung that fails to read is a miss, not an error.
  }
}

export function parseLabCount(value: string | undefined, fallback: number): number | null {
  return value === undefined ? fallback : parsePositiveInteger(value);
}

export function parseParticipantIds(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const participantIds: string[] = [];
  for (const raw of value.split(",")) {
    const participantId = raw.trim();
    if (!participantId || seen.has(participantId)) continue;
    seen.add(participantId);
    participantIds.push(participantId);
  }
  return participantIds;
}

// Exported so tests/cli/program.test.ts can drive the command-boundary catch-all's
// post-write guard (invocationEnvelopeAlreadyWritten above) through the same
// funnel every real command uses, without duplicating its stdout-vs-formatHuman
// branching. Not re-exported from src/index.ts; this stays an internal seam.
/** An error as a result carries it. A result with only a message, such as keys or comms, has no code. */
export interface CliError {
  code?: string;
  message: string;
}

/**
 * What a human formatter prints: text for stdout, or stdout lines plus an error that writeResult
 * prints on stderr through formatCliError. --json output never goes through it.
 */
export type HumanOutput = string | { stdout?: string; error?: CliError | undefined };

/**
 * The command to run next, by code. A code is listed only when its messages do not already name a
 * command: the run-not-found and lab-less run messages do.
 */
const NEXT_COMMAND: Readonly<Record<string, string>> = {
  HUMANISH_STUDY_NOT_FOUND: "humanish study list",
};

/** `<command> failed: <message>`, then `code: <CODE>`, then `next: <command>` when one is known. */
export function formatCliError(command: string, error: CliError): string {
  const next = error.code === undefined ? undefined : NEXT_COMMAND[error.code];
  return (
    [
      `${command} failed: ${error.message}`,
      ...(error.code === undefined ? [] : [`code: ${error.code}`]),
      ...(next === undefined ? [] : [`next: ${next}`]),
    ].join("\n") + "\n"
  );
}

/** A result whose human output is its message: stdout when it passed, stderr when it failed. */
export function messageOutput(value: { ok: boolean; message: string }): HumanOutput {
  return value.ok ? `${value.message}\n` : { error: { message: value.message } };
}

/** A failed result's human output: its error on stderr and nothing on stdout. */
export function humanError(error: CliError | undefined): HumanOutput {
  return { error: error ?? { message: "the command failed without a recorded error" } };
}

/** "humanish study show": the command's path as a person types it. */
function commandLabel(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent)
    names.unshift(current.name());
  return names.join(" ");
}

/** Prints a human formatter's output: text to stdout, an error to stderr through formatCliError. */
export function writeHuman(command: Command, io: CliIo, human: HumanOutput): void {
  if (typeof human === "string") {
    io.writeOut(human);
    return;
  }
  if (human.stdout) io.writeOut(human.stdout);
  if (human.error) io.writeErr(formatCliError(commandLabel(command), human.error));
}

export function writeResult<T>(
  command: Command,
  io: CliIo,
  result: T,
  formatHuman: (result: T) => HumanOutput,
): void {
  const output = automaticAnalysisEnvelope(result);
  if (wantsJson(command)) {
    // Queued warnings are on stderr already; a JSON caller gets them in warnings[] as well.
    io.writeOut(`${JSON.stringify(withQueuedWarnings(command, output), null, 2)}\n`);
  } else {
    writeHuman(command, io, formatHuman(output));
    if (output !== null && typeof output === "object" && "automaticAnalysis" in output) {
      const analysis = (output as AutomaticAnalysisResult).automaticAnalysis;
      if (analysis) io.writeOut(`analysis: ${analysisOutcomeText(analysis)}\n`);
      const rejected = analysis?.result?.rejectedOutputPath;
      if (rejected)
        io.writeOut(
          `analysis: ${analysis.result?.error?.code ?? "rejected"}; the rejected output is kept locally at ${rejected}\n`,
        );
      if (defaultAnalysisOverBudget(output as AutomaticAnalysisResult))
        io.writeOut(overBudgetAnalysisHint(output as AutomaticAnalysisResult & { runId?: string }));
    }
  }
  markInvocationEnvelopeWritten(command);
  // Every backend's result passes through here, so this is where a study's facts get read for
  // telemetry. Reading them in each route instead is how they went unreported for two releases.
  noteRunFacts(command, deriveRunFacts(result));
}

const runFactsByCommand = new WeakMap<Command, TelemetryProperties>();

export function noteRunFacts(command: Command, facts: TelemetryProperties): void {
  if (Object.keys(facts).length === 0) return;
  runFactsByCommand.set(command, { ...runFactsByCommand.get(command), ...facts });
}

/** Exported for tests: the facts writeResult read off a command's result document. */
export function runFactsFor(command: Command): TelemetryProperties {
  return { ...runFactsByCommand.get(command) };
}

/** A run result, or the preview route's study result: they differ only in `schema`. */
export function formatRunHuman(result: Omit<RunResult, "schema">): HumanOutput {
  if (!result.ok) return humanError(result.error);

  return (
    [
      `humanish run ${result.mode}`,
      `run: ${result.runId}`,
      ...(result.simCount === undefined ? [] : [`participants: ${result.simCount}`]),
      `bundle: ${result.bundlePath}`,
      `review: ${result.reviewPath}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

function formatEnvFileHuman(result: EnvFileLoadResult): HumanOutput {
  if (!result.ok) return humanError(result.error);

  return (
    [
      "humanish env-file loaded",
      `env-file: ${result.envFile}`,
      `loaded: ${result.loaded.length ? result.loaded.join(", ") : "none"}`,
      `skipped-existing: ${result.skipped.length ? result.skipped.join(", ") : "none"}`,
    ].join("\n") + "\n"
  );
}

export function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function parseTimeoutMs(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 3_600_000 ? parsed : null;
}

export function parseObserverPort(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 65535 ? parsed : null;
}

/** `--candidate` as the module option, absent when not given (exactOptionalPropertyTypes). */
export function candidateOption(options: {
  candidate?: string;
  analysis?: string;
  finding?: string;
}): {
  candidate?: string;
  analysis?: string;
  finding?: string;
} {
  return {
    ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
    ...(options.finding === undefined ? {} : { finding: options.finding }),
  };
}

export function collectRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function wantsJson(command: Command): boolean {
  let current: Command | null = command;

  while (current) {
    if (current.opts<{ json?: boolean }>().json === true) {
      return true;
    }

    current = current.parent ?? null;
  }

  return false;
}

/** What the automatic analysis did, in words; JSON output keeps the reason code. */
const ANALYSIS_REASON_TEXT: Readonly<Record<string, string>> = {
  AUTOMATIC_ANALYSIS_DRY_RUN: "skipped for dry runs",
  AUTOMATIC_ANALYSIS_KEY_MISSING: "skipped because OPENAI_API_KEY is not set",
  AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE: "skipped because no participant left evidence",
  AUTOMATIC_ANALYSIS_ACTOR_CANCELLED:
    "skipped because the run stopped before its participants finished",
  AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE: "skipped because the run's evidence could not be read",
  AUTOMATIC_ANALYSIS_ALREADY_REQUESTED: "skipped because this run's analysis was already requested",
  AUTOMATIC_ANALYSIS_BUSY: "skipped because another analysis is running",
  AUTOMATIC_ANALYSIS_ADMISSION_REFUSED:
    "not started because its configuration or question was refused",
  AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED: "not started because the run's cleanup was not confirmed",
  AUTOMATIC_ANALYSIS_REUSED: "complete, reusing an earlier analysis of the same evidence",
  AUTOMATIC_ANALYSIS_LIMITATIONS: "partial, because it covered only part of the evidence",
  AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED:
    "partial, because it went over its estimated cost or output",
  AUTOMATIC_ANALYSIS_FAILED: "failed",
  AUTOMATIC_ANALYSIS_CANCELLED: "cancelled",
  AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE: "failed because the Codex analyst could not run",
  AUTOMATIC_ANALYSIS_PUBLICATION_FAILED: "failed because the report could not be saved",
  AUTOMATIC_ANALYSIS_SOURCE_CHANGED: "failed because the run's evidence changed during analysis",
  AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE:
    "outcome unknown: a cancellation could not be recorded",
  AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE: "outcome unknown: analysis storage is unavailable",
  AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN: "outcome unknown",
};

export function analysisOutcomeText(analysis: { state: string; reason: string | null }): string {
  if (analysis.reason === null) return analysis.state;
  return ANALYSIS_REASON_TEXT[analysis.reason] ?? `${analysis.state} (${analysis.reason})`;
}

/** Preserve the run's own result while making requested post-processing failures machine-visible. */
function overBudgetAnalysisHint(result: AutomaticAnalysisResult & { runId?: string }): string {
  const estimate = result.automaticAnalysis?.result?.admission?.estimatedCostUsd ?? null;
  const suggested = Math.ceil(estimate ?? DEFAULT_ANALYSIS_MAX_COST_USD + 1);
  const shown = estimate === null ? "" : ` ($${estimate.toFixed(2)})`;
  return `analysis: its estimate${shown} is over the default $${DEFAULT_ANALYSIS_MAX_COST_USD} cap, so no request was sent. To analyze this run: humanish analyze --run ${result.runId ?? "latest"} --max-cost ${suggested}\n`;
}

export function automaticAnalysisEnvelope<T>(result: T): T {
  if (
    result === null ||
    typeof result !== "object" ||
    !("automaticAnalysis" in result) ||
    !("ok" in result)
  )
    return result;
  const run = result as T & AutomaticAnalysisResult & { ok: boolean };
  return { ...run, runOk: run.ok, ok: run.ok && automaticAnalysisSucceeded(run) };
}
