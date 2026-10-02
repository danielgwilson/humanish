import {
  automaticAnalysisSucceeded,
  defaultAnalysisOverBudget,
  type AutomaticAnalysisResult,
} from "../analysis/automatic-completion.js";
import { DEFAULT_ANALYSIS_MAX_COST_USD } from "../analysis/automatic-config.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadEnvFile } from "../keys/env-file.js";
import { discoverProviderKeys } from "../keys/key-resolution.js";
import type { EnvFileLoadResult } from "../keys/env-file.js";
import { deriveRunFacts, type TelemetryProperties } from "./telemetry.js";
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

// Shared so the ~20 leaf commands that declare their own --json flag cannot drift
// from each other in wording.
export const JSON_OPTION_DESCRIPTION = "Print a machine-readable JSON response.";

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
  /** #316: repo-relative path to an adopter scorer module; overrides review.scorer.ref when set. */
  scorer?: string | undefined;
  // watch --expose surface (tunnel-edge auth). Only the CUA backend live-serves a run; other
  // backends refuse exposure. See runCuaBackend + validateExposure.
  expose?: boolean | undefined;
  tunnel?: "ngrok" | undefined;
  tunnelDomain?: string | undefined;
  oauth?: "google" | undefined;
  allowEmail?: string[] | undefined;
  allowDomain?: string[] | undefined;
  publicUrl?: string | undefined;
  safe?: boolean | undefined;
}

// Transcode ONLY for a terminal. A pipe carries bytes to another program — mangling those would
// corrupt a JSON payload for a reader that handles UTF-8 perfectly well — while a TTY carries them
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
// another's, and nothing needs explicit cleanup -- the entry is released once
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
 * Provider-key discovery (#436): fill still-missing keys from the documented project overlay, the
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
export function writeResult<T>(
  command: Command,
  io: CliIo,
  result: T,
  formatHuman: (result: T) => string,
): void {
  const output = automaticAnalysisEnvelope(result);
  if (wantsJson(command)) {
    io.writeOut(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.writeOut(formatHuman(output));
    if (output !== null && typeof output === "object" && "automaticAnalysis" in output) {
      const analysis = (output as AutomaticAnalysisResult).automaticAnalysis;
      if (analysis)
        io.writeOut(
          `analysis: ${analysis.state}${analysis.reason ? ` (${analysis.reason})` : ""}\n`,
        );
      if (defaultAnalysisOverBudget(output as AutomaticAnalysisResult))
        io.writeOut(overBudgetAnalysisHint(output as AutomaticAnalysisResult & { runId?: string }));
    }
  }
  markInvocationEnvelopeWritten(command);
  // Every backend's result passes through here, so this is where a study's facts get read for
  // telemetry — not in each backend, which is how they went unreported for two releases.
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

export function formatRunHuman(result: RunResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

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

function formatEnvFileHuman(result: EnvFileLoadResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

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

export function collectRepeated(value: string, previous: string[]): string[] {
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
