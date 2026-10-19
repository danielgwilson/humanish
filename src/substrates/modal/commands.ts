// Commands and files in a Modal sandbox, with the E2B SDK's contracts, which the routes were written
// against: a non-zero exit throws CommandExitError, a timeout throws TimeoutError, relative paths
// are under the user's home, and a background command returns a handle to wait on, kill or feed.
//
// Modal runs every exec as root and ignores the image's user setting, so each command drops to the
// sandbox user here, the account E2B runs commands as. Modal has no way to signal one exec, so a
// background command records its pid in a file and is killed by that pid.
import { randomUUID } from "node:crypto";
import { ReadableStream } from "node:stream/web";

import type { E2BCommandResult, E2BCommandRunOptions } from "../e2b/sdk.js";
import { shellQuote } from "../shell.js";
import { MODAL_SANDBOX_USER } from "./image.js";
import type { ModalSandbox } from "./sdk.js";

/** E2B's commands.run default, kept so a caller that sets no timeout gets the same bound. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Modal takes sandbox and command timeouts in whole seconds; a shorter one is rounded up. */
export const wholeSeconds = (ms: number): number => Math.ceil(ms / 1000) * 1000;

/** The argv that runs `command` in a login shell as the sandbox user, in their home. */
function asSandboxUser(command: string): string[] {
  const { uid } = MODAL_SANDBOX_USER;
  return [
    "setpriv",
    `--reuid=${uid}`,
    `--regid=${uid}`,
    "--init-groups",
    "--",
    "bash",
    "-lc",
    command,
  ];
}

const USER_ENV = {
  HOME: MODAL_SANDBOX_USER.home,
  USER: MODAL_SANDBOX_USER.name,
  LOGNAME: MODAL_SANDBOX_USER.name,
};

/** The E2B SDK throws this shape on a non-zero exit; src/substrates/command-failure.ts reads it. */
class ModalCommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`Command exited with code ${exitCode}${stderr ? ` and error:\n${stderr}` : ""}`);
    this.name = "CommandExitError";
  }
  get error(): string {
    return this.stderr;
  }
}

async function collect(
  stream: AsyncIterable<string | Uint8Array>,
  onData: ((data: string) => void | Promise<void>) | undefined,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    const data = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    text += data;
    if (onData !== undefined && data !== "") await onData(data);
  }
  return text;
}

/** Modal ends a command at its timeout and reports it as a deadline; E2B names it TimeoutError. */
function named(error: unknown, timeoutMs: number): unknown {
  if (!(error instanceof Error) || !/deadline exceeded/i.test(error.message)) return error;
  const timeout = new Error(`Command did not finish within ${timeoutMs} ms.`, { cause: error });
  timeout.name = "TimeoutError";
  return timeout;
}

/** Run `command` as the sandbox user, to completion or, with `background`, returning a handle. */
export async function runCommand(
  sandbox: ModalSandbox,
  command: string,
  options: E2BCommandRunOptions = {},
): Promise<E2BCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const pidFile = options.background === true ? `/tmp/humanish-exec-${randomUUID()}.pid` : "";
  const line =
    options.background === true
      ? `printf '%s\\n' "$$" > ${pidFile}; exec bash -c ${shellQuote(command)}`
      : command;
  let finished: Promise<E2BCommandResult>;
  let child: Awaited<ReturnType<ModalSandbox["exec"]>>;
  try {
    child = await sandbox.exec(asSandboxUser(line), {
      env: { ...USER_ENV, ...options.envs },
      ...(options.cwd === undefined ? {} : { workdir: options.cwd }),
      ...(timeoutMs > 0 ? { timeoutMs: wholeSeconds(timeoutMs) } : {}),
    });
    // E2B starts a command with no stdin unless asked; a Modal exec keeps the pipe open, and a
    // reader such as codex exec would wait on it until its timeout.
    if (options.stdin !== true) await child.closeStdin();
    const running = child;
    finished = Promise.all([
      collect(running.stdout, options.onStdout),
      collect(running.stderr, options.onStderr),
      running.wait(),
    ]).then(([stdout, stderr, exitCode]) => {
      if (exitCode !== 0) throw new ModalCommandExitError(exitCode, stdout, stderr);
      return { exitCode, stdout, stderr };
    });
  } catch (error) {
    throw named(error, timeoutMs);
  }
  if (options.background !== true)
    return finished.catch((error: unknown) => {
      throw named(error, timeoutMs);
    });
  // The caller decides when to wait; an exit nobody waits for is not an unhandled rejection.
  finished.catch(() => {});
  const running = child;
  // E2B's handle carries the process's pid, which owners such as the recorder check.
  const pid = await backgroundPid(sandbox, pidFile);
  return {
    ...(pid === undefined ? {} : { pid }),
    wait: () => finished,
    kill: async () => {
      const killed = await runCommand(
        sandbox,
        `kill -KILL "$(cat ${pidFile})" 2>/dev/null && echo killed || true`,
        { timeoutMs: 10_000 },
      );
      return killed.stdout?.trim() === "killed";
    },
    sendStdin: (data) =>
      typeof data === "string" ? running.stdin.writeText(data) : running.stdin.writeBytes(data),
    closeStdin: () => running.stdin.close(),
  };
}

/** How long a background command has to record its pid before its handle reports none. */
const PID_WAIT_MS = 5_000;

/** The pid a background command wrote to `pidFile`, or undefined if none arrived in time. */
async function backgroundPid(sandbox: ModalSandbox, pidFile: string): Promise<number | undefined> {
  for (const end = Date.now() + PID_WAIT_MS; Date.now() < end;) {
    const read = await runCommand(sandbox, `cat ${pidFile} 2>/dev/null || true`, {
      timeoutMs: 10_000,
    });
    const pid = Number(read.stdout?.trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/** Relative paths are under the sandbox user's home, as on E2B. */
export function sandboxPath(path: string): string {
  return path.startsWith("/") ? path : `${MODAL_SANDBOX_USER.home}/${path}`;
}

export async function writeFile(sandbox: ModalSandbox, path: string, data: string | ArrayBuffer) {
  const target = sandboxPath(path);
  const child = await sandbox.exec(
    asSandboxUser('mkdir -p -- "$(dirname -- "$0")" && cat > "$0"').concat(target),
    { mode: "binary", env: USER_ENV },
  );
  await child.stdin.writeBytes(
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
  );
  await child.stdin.close();
  const [stderr, exitCode] = await Promise.all([child.stderr.readBytes(), child.wait()]);
  if (exitCode !== 0)
    throw new ModalCommandExitError(exitCode, "", new TextDecoder().decode(stderr));
  return { path: target };
}

/** A file's bytes as a stream, read as the sandbox user. */
export async function readFile(
  sandbox: ModalSandbox,
  path: string,
): Promise<ReadableStream<Uint8Array>> {
  const child = await sandbox.exec(asSandboxUser('cat -- "$0"').concat(sandboxPath(path)), {
    mode: "binary",
    env: USER_ENV,
  });
  await child.closeStdin();
  const bytes = async function* () {
    for await (const chunk of child.stdout)
      yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    const exitCode = await child.wait();
    if (exitCode !== 0)
      throw new ModalCommandExitError(exitCode, "", await child.stderr.readText());
  };
  return ReadableStream.from(bytes());
}

/** A file's bytes, whole. */
export async function readBytes(sandbox: ModalSandbox, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of await readFile(sandbox, path)) parts.push(chunk);
  return Buffer.concat(parts);
}
