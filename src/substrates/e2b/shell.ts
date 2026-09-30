import { isCommandExitError } from "../command-failure.js";
import type { Shell, ShellCallOptions, ShellResult } from "../shell.js";
import { withOneRetryOnTransientE2BError, type E2BDesktopSandbox } from "./desktop-launch.js";

/** The part of an E2B sandbox handle a Shell needs. */
export type E2BShellHandle = Pick<E2BDesktopSandbox, "commands" | "files">;

/**
 * A Shell over an E2B sandbox. The SDK throws CommandExitError on a non-zero exit; this returns
 * it as a result. Methods are read from the handle on every call, so a handle whose methods are
 * replaced later is still the one used.
 */
export function e2bShell(sandbox: E2BShellHandle): Shell {
  const run = async (command: string, options?: ShellCallOptions): Promise<ShellResult> => {
    try {
      const result = await (options === undefined
        ? sandbox.commands.run(command)
        : sandbox.commands.run(command, options));
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (error) {
      if (!isCommandExitError(error)) throw error;
      return exitResult(error);
    }
  };
  return {
    run,
    start: (command, options) => run(`setsid -f ${command} < /dev/null > /dev/null 2>&1`, options),
    async writeFile(path, data, options) {
      // Binary data goes as an octet stream, as the archive upload always has.
      const writeOptions = {
        ...(options?.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(typeof data === "string" ? {} : { useOctetStream: true }),
      };
      const write = () =>
        Object.keys(writeOptions).length === 0
          ? sandbox.files.write(path, data)
          : sandbox.files.write(path, data, writeOptions);
      if (options?.retryOnce === undefined) await write();
      else await withOneRetryOnTransientE2BError(write, options.retryOnce);
    },
  };
}

function exitResult(error: unknown): ShellResult {
  const e = error as {
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    error?: unknown;
    message?: unknown;
  };
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    exitCode: typeof e.exitCode === "number" ? e.exitCode : 1,
    stdout: text(e.stdout),
    // The SDK puts the process's stderr in `stderr` and the envd reason in `error`/`message`.
    stderr: text(e.stderr) || text(e.error) || text(e.message),
  };
}
