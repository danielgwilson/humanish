// Detached process management over a Shell, the primitive behind serving a subject app in the
// sandbox. A foreground command hits its deadline on long-running work, so long work runs detached:
//
// - Scripts are written via `writeFile`, never heredocs, which eliminates the
//   sentinel-collision bug class (a command line that equals the heredoc terminator) by
//   construction. The author's command is a script file of its own, so bash parses it apart
//   from the wrapper: a syntax error in it is that script's exit 2, logged, and the wrapper
//   still writes the status.
// - Bounded steps (install/build) run detached with an atomically-written status file
//   (write tmp + mv), polled by short foreground commands; a timeout kills the process
//   group and surfaces a capped log tail for the caller to redact and persist.
// - Long-lived steps (a dev/prod server) launch fully detached through `Shell.start`; the
//   sandbox lifecycle (kill-on-timeout) owns their reclamation.
// - Readiness is an explicit curl probe against the declared URL.
//
// Log tails are returned raw; callers must pass them through redaction before persisting
// (build output can echo env values and paths).

import { runOrThrow, shellQuote, throwOnExit, type Shell } from "./shell.js";

const WORK_ROOT = "/tmp/humanish-subject";
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOG_TAIL_BYTES = 8192;
const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface DetachedTimers {
  /** Injected clock (ms) for tests. */
  now?: () => number;
  /** Injected sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The clock and sleep a caller injected, without keys it left absent. */
export function detachedTimersOf(options: DetachedTimers): DetachedTimers {
  return {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}

export interface DetachedStepOptions extends DetachedTimers {
  /** Short [a-z0-9-] label; names the script/status/log files under /tmp. */
  name: string;
  /** The shell command to run (the study author's own command: package.json-script trust). */
  command: string;
  cwd?: string;
  /** Wall-clock budget for the step. */
  timeoutMs: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface DetachedStepResult {
  ok: boolean;
  exitCode?: number;
  timedOut: boolean;
  /** Capped, unredacted log tail; redact before persisting. */
  logTail: string;
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Detached step name must match ${NAME_PATTERN} (got "${name}").`);
  }
}

function stepDir(name: string): string {
  return `${WORK_ROOT}/${name}`;
}

// The wrapper script: runs the command script from its own session (Shell.start makes the
// wrapper the process-group leader, so `kill -- -PID` reclaims the whole tree), logs everything,
// and writes the exit code atomically so a poller can never read a half-written status. It holds
// no author text, so it always parses and always reaches the status write.
function wrapperScript(name: string, cwd: string | undefined): string {
  const dir = stepDir(name);
  return [
    "#!/bin/bash",
    `mkdir -p ${shellQuote(dir)}`,
    `echo $$ > ${shellQuote(`${dir}/pid`)}`,
    cwd === undefined
      ? ": # no cwd override"
      : `cd ${shellQuote(cwd)} || { echo 127 > ${shellQuote(`${dir}/status.tmp`)}; mv ${shellQuote(`${dir}/status.tmp`)} ${shellQuote(`${dir}/status`)}; exit 127; }`,
    `bash ${shellQuote(`${dir}/command.sh`)} > ${shellQuote(`${dir}/log.txt`)} 2>&1`,
    "code=$?",
    `echo $code > ${shellQuote(`${dir}/status.tmp`)}`,
    `mv ${shellQuote(`${dir}/status.tmp`)} ${shellQuote(`${dir}/status`)}`,
    "exit $code",
    "",
  ].join("\n");
}

async function writeAndLaunch(
  shell: Shell,
  name: string,
  command: string,
  cwd: string | undefined,
  requestTimeoutMs: number,
): Promise<void> {
  assertName(name);
  const dir = stepDir(name);
  const scriptPath = `${dir}/run.sh`;
  await runOrThrow(shell, `mkdir -p ${shellQuote(dir)}`, { requestTimeoutMs });
  // The study parser trims each command, so a YAML `|` block arrives without its final newline.
  // bash closes a heredoc whose delimiter is a script's last line either way; the newline makes
  // the file plain text.
  await shell.writeFile(`${dir}/command.sh`, `${command}\n`);
  await shell.writeFile(scriptPath, wrapperScript(name, cwd));
  throwOnExit(await shell.start(`bash ${shellQuote(scriptPath)}`, { requestTimeoutMs }));
}

/** Read the capped log tail for a step (raw; caller redacts). */
export async function readDetachedLog(
  shell: Shell,
  name: string,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<string> {
  assertName(name);
  const result = await runOrThrow(
    shell,
    `tail -c ${LOG_TAIL_BYTES} ${shellQuote(`${stepDir(name)}/log.txt`)} 2>/dev/null || true`,
    { requestTimeoutMs },
  );
  return result.stdout;
}

/**
 * Run a bounded step (install/build) detached, polling its atomic status file until it
 * exits or the budget runs out. On timeout the process group is killed and the log tail is
 * still captured so failures stay diagnosable.
 */
export async function runDetachedStep(
  shell: Shell,
  options: DetachedStepOptions,
): Promise<DetachedStepResult> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dir = stepDir(options.name);

  await writeAndLaunch(shell, options.name, options.command, options.cwd, requestTimeoutMs);

  const deadline = now() + options.timeoutMs;
  for (;;) {
    const status = await runOrThrow(
      shell,
      `cat ${shellQuote(`${dir}/status`)} 2>/dev/null || true`,
      {
        requestTimeoutMs,
      },
    );
    const text = status.stdout.trim();
    if (text.length > 0) {
      const exitCode = Number.parseInt(text, 10);
      const logTail = await readDetachedLog(shell, options.name, requestTimeoutMs);
      return { ok: exitCode === 0, exitCode, timedOut: false, logTail };
    }
    if (now() >= deadline) {
      // Kill the whole process group (the script is its own session leader via Shell.start).
      await shell
        .run(`kill -- -$(cat ${shellQuote(`${dir}/pid`)} 2>/dev/null) 2>/dev/null || true`, {
          requestTimeoutMs,
        })
        .catch(() => undefined);
      const logTail = await readDetachedLog(shell, options.name, requestTimeoutMs);
      return { ok: false, timedOut: true, logTail };
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Launch a long-lived process (the subject's server) fully detached and return immediately.
 * No status polling: liveness is the caller's readiness probe, and reclamation belongs to
 * the sandbox lifecycle (create with kill-on-timeout).
 */
export async function startDetachedProcess(
  shell: Shell,
  options: { name: string; command: string; cwd?: string; requestTimeoutMs?: number },
): Promise<void> {
  await writeAndLaunch(
    shell,
    options.name,
    options.command,
    options.cwd,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
}

/**
 * Poll a URL from inside the sandbox until it answers 2xx/3xx or the budget runs out.
 * Returns true when the subject is ready.
 */
export async function probeUrl(
  shell: Shell,
  url: string,
  options: { timeoutMs: number; intervalMs?: number; requestTimeoutMs?: number } & DetachedTimers,
): Promise<boolean> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 1500;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const result = await shell
      .run(`curl -sf -o /dev/null --max-time 5 ${shellQuote(url)} && echo READY || echo WAIT`, {
        requestTimeoutMs,
      })
      .catch(() => ({ stdout: "WAIT" }));
    if (result.stdout.includes("READY")) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}
