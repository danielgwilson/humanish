// The command channel into a machine. Subject provisioning and in-sandbox comms use only this, so
// a machine provider has to supply a Shell for them to run there. The E2B implementation is
// src/substrates/e2b/shell.ts.

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ShellCallOptions {
  /** How long to wait for the machine to answer the call. */
  requestTimeoutMs?: number;
  /** How long the command itself may run. */
  timeoutMs?: number;
  /** Environment for this command only, added to the machine's own. */
  env?: Readonly<Record<string, string>>;
}

interface ShellWriteOptions {
  requestTimeoutMs?: number;
  /**
   * Retry a transient transport failure once. The provider decides what is transient. Writes
   * replace the whole file, so a repeat is safe.
   */
  retryOnce?: { onRetry?: (reason: string) => void; sleep?: (ms: number) => Promise<void> };
}

export interface Shell {
  /** Run a command to completion. A non-zero exit resolves as a result; only transport rejects. */
  run(command: string, options?: ShellCallOptions): Promise<ShellResult>;
  /**
   * Launch a command in its own session and resolve once it is launched, without waiting for it
   * to exit. The result is the launcher's. The machine's lifetime reclaims the process.
   */
  start(command: string, options?: ShellCallOptions): Promise<ShellResult>;
  /** Create or replace a file. */
  writeFile(path: string, data: string | ArrayBuffer, options?: ShellWriteOptions): Promise<void>;
}

/** Run a command whose non-zero exit the caller cannot use, and reject on one. */
export async function runOrThrow(
  shell: Shell,
  command: string,
  options?: ShellCallOptions,
): Promise<ShellResult> {
  return throwOnExit(await shell.run(command, options));
}

/** Reject a non-zero result with its exit code and a short tail of its output. */
export function throwOnExit(result: ShellResult): ShellResult {
  if (result.exitCode === 0) return result;
  const tail = tailOf(result.stderr || result.stdout);
  throw new Error(`command exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
}

/** Single-quote a value for a Shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Sanitized, whitespace-collapsed, length-capped tail of command output. */
export function tailOf(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(-240);
}
