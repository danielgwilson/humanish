// Shared handling for @e2b/desktop command failures.
//
// The SDK's `commands.run` throws a CommandExitError on any non-zero exit (e2b 2.49.0:
// CommandHandle.wait), so a caller that reads `result.exitCode` after a raw call never sees a
// failure. Desktop code runs commands through e2bShell (src/substrates/e2b/shell.ts), which turns
// that throw into a result. These helpers recover the exit code and a sanitized output tail from
// the throw for the callers that still meet it directly, such as the desktop executor.
//
// Public-safety: only the substrate's own output (stderr/stdout/error/message) is
// read here; caller-supplied text (e.g. typed input) must never be passed to the
// failing command as an argument, so it cannot appear in these fields.

/**
 * True when `error` is (structurally) the @e2b/desktop CommandExitError: a
 * non-zero substrate command exit that the real Sandbox surfaces as a THROW.
 * Matches either the SDK class name (`name === "CommandExitError"`) or any object
 * carrying a numeric `exitCode` (the same field `commandFailureInfo` reads, so a
 * structural fake is covered without importing the SDK class).
 *
 * Deliberately conservative — it is the RECOVERABILITY predicate the CUA loop uses
 * to skip a single failed desktop action instead of ending the whole run: it must
 * NOT match a deadline/abort control-flow signal (those subclass Error without a
 * name override or an exitCode) or a generic Error with no exit signal, so only a
 * genuine substrate-command failure is treated as recoverable.
 */
import { tailOf } from "./shell.js";

export function isCommandExitError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { name?: unknown; exitCode?: unknown };
  return e.name === "CommandExitError" || typeof e.exitCode === "number";
}

/**
 * Recover the exit code + a sanitized stderr/stdout tail from a command failure.
 * The real @e2b/desktop CommandExitError exposes exitCode/stderr/stdout/error;
 * these are read structurally so the caller does not depend on the SDK class.
 */
export function commandFailureInfo(error: unknown): { exitCode?: number; stderrTail: string } {
  const e = (error ?? {}) as {
    exitCode?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    error?: unknown;
    message?: unknown;
  };
  const exitCode = typeof e.exitCode === "number" ? e.exitCode : undefined;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const source = str(e.stderr) ?? str(e.stdout) ?? str(e.error) ?? str(e.message);
  return exitCode === undefined
    ? { stderrTail: tailOf(source) }
    : { exitCode, stderrTail: tailOf(source) };
}
