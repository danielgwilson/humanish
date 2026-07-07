// Shared handling for @e2b/desktop command failures.
//
// The real Sandbox's `commands.run` THROWS a CommandExitError on any non-zero
// exit (it does not return a non-zero exitCode), so a site that only inspects
// `result.exitCode` after the call never reaches its non-zero branch in
// production -- the intended, formatted error is lost and a raw CommandExitError
// propagates instead. These helpers recover the exit code + a sanitized output
// tail from the throw, and wrap a run so a site can convert the throw into its
// own intended error while still handling a non-throwing (fake) runner shape.
//
// Public-safety: only the substrate's own output (stderr/stdout/error/message) is
// read here; caller-supplied text (e.g. typed input) must never be passed to the
// failing command as an argument, so it cannot appear in these fields.

/** Sanitized, whitespace-collapsed, length-capped tail of command output. */
export function tailOf(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(-240);
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
  return exitCode === undefined ? { stderrTail: tailOf(source) } : { exitCode, stderrTail: tailOf(source) };
}

/**
 * Run a desktop command; if the substrate THROWS on a non-zero exit (the real
 * @e2b/desktop behavior), convert the throw into the caller's intended error via
 * `onFailure` (which returns the value to throw -- a new Error, or the original
 * error to preserve raw propagation). A non-throwing runner that RETURNS a
 * non-zero exitCode is left to the caller's own post-call check.
 */
export async function runDesktopCommandOrThrow<T>(
  run: () => Promise<T>,
  onFailure: (info: { exitCode?: number; stderrTail: string }, error: unknown) => unknown,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw onFailure(commandFailureInfo(error), error);
  }
}
