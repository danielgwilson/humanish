// Starting a run from the terminal surface (#455).
//
// THE RUN MUST OUTLIVE THE SURFACE. A study can take minutes and costs real money, so a run
// started from the TUI cannot be a child of the TUI's event loop: closing the surface, or losing
// the SSH session it is running over, must not kill it. So this spawns the CLI the same way a
// person would type it — detached, in its own process group, with its output going to a file
// rather than to a terminal that may be about to disappear.
//
// The surface then learns what happened the same way any other reader does: from `status.json`.
// It does not hold a handle to the run, parse its stdout, or track it in memory. That is what
// makes the surface restartable — quit the TUI mid-run, reopen it, and the run is still there,
// because the filesystem was always the source of truth rather than a process handle.

import { spawn, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareManagedHumanishOutputDirectory } from "./selected-output-paths.js";

/**
 * A lab handle is the manifest FILENAME, which is what `humanish lab run` resolves. Restricted to
 * characters a manifest name can actually contain, and — the part that matters — never allowed to
 * begin with `-`, because argv is positional: a lab called `--json` would otherwise be handed to
 * the CLI as a flag. There is no shell involved, so this is the whole injection surface.
 *
 * A leading underscore IS allowed: `_wip.yaml` is an ordinary way to name a work-in-progress
 * manifest, `humanish lab run _wip` resolves it, and refusing it here would leave the surface
 * listing a lab it will not start. A leading dot stays out — that names a hidden file, not a lab.
 */
const SAFE_LAB_HANDLE = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/;

export function isSafeLabHandle(value: string): boolean {
  return SAFE_LAB_HANDLE.test(value) && value.length <= 128;
}

export interface LaunchRunOptions {
  cwd: string;
  /** The manifest handle (filename stem), as `humanish lab run` takes it. */
  lab: string;
  mode: "dry-run" | "live";
  /** Injected in tests; defaults to the real spawn. */
  spawn?: typeof spawn;
  /** Injected in tests; defaults to the CLI beside this module. */
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected clock so a test can pin the log filename. */
  now?: () => Date;
}

export interface LaunchedRun {
  /** The spawned CLI's pid. The run's `status.json` stamps the same value. */
  pid: number;
  /**
   * When the launch happened. A pid ALONE cannot identify a run: pids are recycled by the OS and a
   * finished run keeps its pid in `status.json` forever, so a week-old record can carry the pid the
   * kernel just handed this child. Anything matching on pid must also require the record to be
   * newer than this.
   */
  launchedAt: string;
  /** Absolute path to the launch log; the only diagnosis when a run dies before writing evidence. */
  logPath: string;
  /** Exactly what was executed, so a failure can be reproduced by hand. */
  command: readonly string[];
}

export type LaunchRunResult =
  | { ok: true; run: LaunchedRun }
  | { ok: false; error: { code: LaunchErrorCode; message: string } };

export type LaunchErrorCode = "HUMANISH_LAUNCH_INVALID_LAB" | "HUMANISH_LAUNCH_FAILED";

/** Where the CLI lives, relative to this compiled module. */
function defaultCliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/**
 * Start a run and return as soon as it is running. Never throws: a launch that cannot happen is a
 * result the surface can render, not an exception that would tear down the screen.
 */
export async function launchRun(options: LaunchRunOptions): Promise<LaunchRunResult> {
  if (!isSafeLabHandle(options.lab)) {
    return {
      ok: false,
      error: {
        code: "HUMANISH_LAUNCH_INVALID_LAB",
        message: `"${options.lab}" is not a usable lab handle. Run it by path with \`humanish lab run <path>\` instead.`
      }
    };
  }

  const cwd = path.resolve(options.cwd);
  const now = options.now ?? (() => new Date());
  const spawnFn = options.spawn ?? spawn;
  const launchedAt = now().toISOString();

  let logPath: string;
  let handle;
  try {
    // Contained under `.humanish/`, through the same guard every other output path uses, so a
    // symlinked directory cannot redirect the log somewhere outside the project.
    const logDir = await prepareManagedHumanishOutputDirectory(cwd, "launches");
    const stamp = launchedAt.replace(/[:.]/g, "-");
    logPath = path.join(logDir.physicalPath, `${stamp}-${options.lab}.log`);
    // O_NOFOLLOW so a symlink planted at this path cannot redirect a run's output — which may carry
    // provider error text — outside the project, and cannot defeat the 0600 mode by pointing at a
    // file that already exists with looser permissions. O_CREAT|O_APPEND keeps ordinary reuse
    // working; only a symlink is refused (ELOOP).
    handle = await open(logPath, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "HUMANISH_LAUNCH_FAILED",
        message: `Could not open a launch log: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    };
  }

  // `--json` because nothing reads this stream interactively; `--no-open` because the surface owns
  // the operator's attention and must not have a browser thrown over it.
  const args = [
    options.cliPath ?? defaultCliPath(),
    "lab",
    "run",
    "--cwd",
    cwd,
    "--json",
    "--no-open",
    ...(options.mode === "dry-run" ? ["--dry-run"] : []),
    // `--` ends option parsing, so the handle can only ever be read as the positional argument.
    "--",
    options.lab
  ];

  const spawnOptions: SpawnOptions = {
    cwd,
    env: options.env ?? process.env,
    // A new process group, so the SIGHUP that arrives when a terminal closes is not delivered here.
    detached: true,
    // stdin closed, output to the log: a detached process must never hold the terminal, and
    // inheriting a pipe nobody reads is how a run blocks forever on a full buffer.
    stdio: ["ignore", handle.fd, handle.fd]
  };

  try {
    const child = spawnFn(process.execPath, args, spawnOptions);
    // A spawn failure is delivered ASYNCHRONOUSLY as an 'error' event (EAGAIN, EMFILE, ENOMEM, a
    // vanished node binary). An 'error' event with no listener is re-thrown by EventEmitter as an
    // uncaught exception — which would tear down the whole surface, the one thing this module
    // promises never to do. The run is already unref'd and unobserved, so recording it is all that
    // is available; the operator learns about it from the launch log and the missing record.
    child.on("error", () => {
      // Deliberately empty: see above. The failure surfaces as a run that never reports in.
    });
    if (child.pid === undefined) {
      await handle.close();
      return {
        ok: false,
        error: { code: "HUMANISH_LAUNCH_FAILED", message: "The run process did not start." }
      };
    }
    // Release the surface's hold: the parent can now exit whenever it likes and the run continues,
    // reparented to init.
    child.unref();
    // The child owns the descriptor now.
    await handle.close();
    return {
      ok: true,
      run: { pid: child.pid, launchedAt, logPath, command: [process.execPath, ...args] }
    };
  } catch (cause) {
    await handle.close().catch(() => undefined);
    return {
      ok: false,
      error: {
        code: "HUMANISH_LAUNCH_FAILED",
        message: cause instanceof Error ? cause.message : String(cause)
      }
    };
  }
}

/** Read the tail of a launch log — the only account of a run that died before writing evidence. */
export async function readLaunchLogTail(logPath: string, maxBytes = 4_000): Promise<string> {
  try {
    const handle = await open(logPath, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(Math.min(size, maxBytes));
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8").trim();
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
