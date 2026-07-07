// Detached process management for E2B sandboxes — the substrate primitive behind serving a
// subject app in-sandbox. E2B's foreground `commands.run` deadlines on long-running work, so
// every consumer of the pattern has historically re-implemented the same workaround. This
// module lands it once:
//
// - Scripts are written via `files.write`, never heredocs — which eliminates the
//   sentinel-collision bug class (a command line that equals the heredoc terminator) by
//   construction.
// - Bounded steps (install/build) run detached with an ATOMICALLY-written status file
//   (write tmp + mv), polled by short foreground commands; a timeout kills the process
//   group and surfaces a capped log tail for the caller to redact and persist.
// - Long-lived steps (a dev/prod server) launch fully detached via `setsid -f`; the sandbox
//   lifecycle (kill-on-timeout) owns their reclamation.
// - Readiness is an explicit curl probe against the declared URL.
//
// Log tails are returned RAW; callers must pass them through redaction before persisting
// (build output can echo env values and paths).

import type { E2BDesktopSandbox } from "./e2b-desktop-launch.js";

const WORK_ROOT = "/tmp/homun-subject";
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

export interface DetachedStepOptions extends DetachedTimers {
  /** Short [a-z0-9-] label; names the script/status/log files under /tmp. */
  name: string;
  /** The shell command to run (the lab author's own command — package.json-script trust). */
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
  /** Capped, UNREDACTED log tail — redact before persisting. */
  logTail: string;
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Detached step name must match ${NAME_PATTERN} (got "${name}").`);
  }
}

/** Single-quote a value for safe interpolation into a shell script. */
function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stepDir(name: string): string {
  return `${WORK_ROOT}/${name}`;
}

// The wrapper script: runs the command from its own session (setsid launch makes the script
// the process-group leader, so `kill -- -PID` reclaims the whole tree), logs everything, and
// writes the exit code atomically so a poller can never read a half-written status.
function wrapperScript(name: string, command: string, cwd: string | undefined): string {
  const dir = stepDir(name);
  return [
    "#!/bin/bash",
    `mkdir -p ${shq(dir)}`,
    `echo $$ > ${shq(`${dir}/pid`)}`,
    cwd === undefined ? ": # no cwd override" : `cd ${shq(cwd)} || { echo 127 > ${shq(`${dir}/status.tmp`)}; mv ${shq(`${dir}/status.tmp`)} ${shq(`${dir}/status`)}; exit 127; }`,
    `( ${command} ) > ${shq(`${dir}/log.txt`)} 2>&1`,
    "code=$?",
    `echo $code > ${shq(`${dir}/status.tmp`)}`,
    `mv ${shq(`${dir}/status.tmp`)} ${shq(`${dir}/status`)}`,
    "exit $code",
    ""
  ].join("\n");
}

async function writeAndLaunch(
  desktop: E2BDesktopSandbox,
  name: string,
  command: string,
  cwd: string | undefined,
  requestTimeoutMs: number
): Promise<void> {
  assertName(name);
  const dir = stepDir(name);
  const scriptPath = `${dir}/run.sh`;
  await desktop.commands.run(`mkdir -p ${shq(dir)}`, { requestTimeoutMs });
  await desktop.files.write(scriptPath, wrapperScript(name, command, cwd));
  await desktop.commands.run(
    `chmod +x ${shq(scriptPath)} && setsid -f ${shq(scriptPath)} < /dev/null > /dev/null 2>&1`,
    { requestTimeoutMs }
  );
}

/** Read the capped log tail for a step (raw — caller redacts). */
export async function readDetachedLog(
  desktop: E2BDesktopSandbox,
  name: string,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<string> {
  assertName(name);
  const result = await desktop.commands.run(
    `tail -c ${LOG_TAIL_BYTES} ${shq(`${stepDir(name)}/log.txt`)} 2>/dev/null || true`,
    { requestTimeoutMs }
  );
  return result.stdout ?? "";
}

/**
 * Run a BOUNDED step (install/build) detached, polling its atomic status file until it
 * exits or the budget runs out. On timeout the process group is killed and the log tail is
 * still captured so failures stay diagnosable.
 */
export async function runDetachedStep(
  desktop: E2BDesktopSandbox,
  options: DetachedStepOptions
): Promise<DetachedStepResult> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dir = stepDir(options.name);

  await writeAndLaunch(desktop, options.name, options.command, options.cwd, requestTimeoutMs);

  const deadline = now() + options.timeoutMs;
  for (;;) {
    const status = await desktop.commands.run(`cat ${shq(`${dir}/status`)} 2>/dev/null || true`, { requestTimeoutMs });
    const text = (status.stdout ?? "").trim();
    if (text.length > 0) {
      const exitCode = Number.parseInt(text, 10);
      const logTail = await readDetachedLog(desktop, options.name, requestTimeoutMs);
      return { ok: exitCode === 0, exitCode, timedOut: false, logTail };
    }
    if (now() >= deadline) {
      // Kill the whole process group (the script is its own session leader via setsid).
      await desktop.commands
        .run(`kill -- -$(cat ${shq(`${dir}/pid`)} 2>/dev/null) 2>/dev/null || true`, { requestTimeoutMs })
        .catch(() => undefined);
      const logTail = await readDetachedLog(desktop, options.name, requestTimeoutMs);
      return { ok: false, timedOut: true, logTail };
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Launch a LONG-LIVED process (the subject's server) fully detached and return immediately.
 * No status polling: liveness is the caller's readiness probe, and reclamation belongs to
 * the sandbox lifecycle (create with kill-on-timeout).
 */
export async function startDetachedProcess(
  desktop: E2BDesktopSandbox,
  options: { name: string; command: string; cwd?: string; requestTimeoutMs?: number }
): Promise<void> {
  await writeAndLaunch(
    desktop,
    options.name,
    options.command,
    options.cwd,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
}

/**
 * Poll a URL from INSIDE the sandbox until it answers 2xx/3xx or the budget runs out.
 * Returns true when the subject is ready.
 */
export async function probeUrl(
  desktop: E2BDesktopSandbox,
  url: string,
  options: { timeoutMs: number; intervalMs?: number; requestTimeoutMs?: number } & DetachedTimers
): Promise<boolean> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 1500;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const result = await desktop.commands
      .run(`curl -sf -o /dev/null --max-time 5 ${shq(url)} && echo READY || echo WAIT`, { requestTimeoutMs })
      .catch(() => ({ stdout: "WAIT" }));
    if ((result.stdout ?? "").includes("READY")) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}
