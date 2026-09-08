// The two things a run card can DO (#455 rev 8).
//
// The mock's run screen is an outcome CARD with actions, not a field list, and an action that does
// nothing is worse than no action — so this ships the two that are genuinely implementable today
// and nothing else. `Share…` waits for the export contract (#471) rather than appearing as a
// control that fails.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { RUN_STATUS_FILE, isRunStatusRecord } from "./run-status.js";
import { resolveRunPath } from "./run.js";
import { bindExistingRunArtifactPaths, isSafeRunIdSegment } from "./run-paths.js";
import { openTarget } from "./observer.js";
import { serveObserverLibrary, type ServeLibraryServer } from "./observer-serve.js";

export const TUI_ACTION_SCHEMA = "humanish.tui-action.v1";

export interface TuiActionResult {
  schema: typeof TUI_ACTION_SCHEMA;
  ok: boolean;
  /** What to tell the operator. Always set: an action that appears to do nothing is a bug. */
  message: string;
}

/** A TUI owns one evidence server, shared by its open browser tabs and closed when it exits. */
export interface TuiObserverSession {
  open(cwd: string, observerPath: string): Promise<TuiActionResult>;
  close(): Promise<void>;
}

/**
 * The library server projects the latest contained bundle on each browser poll. It can follow
 * captures written by another process without starting a study or recovering desktop credentials.
 * Keeping it in this process avoids detached viewers accumulating each time Open Observer is used.
 */
export function createTuiObserverSession(
  cwdInput: string,
  options: { openTarget?: typeof openTarget } = {}
): TuiObserverSession {
  const cwd = path.resolve(cwdInput);
  const open = options.openTarget ?? openTarget;
  let serverPromise: Promise<ServeLibraryServer> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const result = (ok: boolean, message: string): TuiActionResult => ({ schema: TUI_ACTION_SCHEMA, ok, message });

  return {
    async open(targetCwd, observerPath) {
      if (closed) return result(false, "this terminal session has closed — reopen humanish tui to view the run");
      if (path.resolve(targetCwd) !== cwd) return result(false, "Observer can only open runs from this terminal session's project");

      // The capability takes the run-card path, not an arbitrary file, URL, or second project.
      // Validate the exact shape before using its id, then enforce the existing physical storage
      // boundary (including descendant symlinks). An index.html need not exist during an active
      // run: the HTTP server renders it from the contained run.json or observer-data.json.
      const relative = path.relative(cwd, path.resolve(cwd, observerPath));
      const segments = relative.split(path.sep);
      const runId = segments[2];
      if (segments.length !== 5 || segments[0] !== ".humanish" || segments[1] !== "runs"
        || !runId || !isSafeRunIdSegment(runId) || segments[3] !== "observer" || segments[4] !== "index.html") {
        return result(false, "Observer requires a run under this project's .humanish/runs directory");
      }
      try {
        await bindExistingRunArtifactPaths(cwd, runId);
      } catch {
        return result(false, "this run's evidence directory is missing or unsafe to open");
      }
      if (closed) return result(false, "this terminal session has closed — reopen humanish tui to view the run");

      try {
        // Share the pending start too: two quick selections must not create two listeners.
        serverPromise ??= serveObserverLibrary(cwd, {
          port: 0, safe: false, expose: false, edgeAuthed: false
        }).then((started) => {
          if (!started.ok) throw new Error(started.error.message);
          return started.server;
        }).catch((error: unknown) => {
          serverPromise = undefined;
          throw error;
        });
        const server = await serverPromise;
        if (closed) return result(false, "this terminal session has closed — reopen humanish tui to view the run");
        const url = new URL(`_humanish/runs/${encodeURIComponent(runId)}/observer/index.html`, server.url).href;
        const opened = open(url);
        return result(true, `${url} — follows saved captures; keep this TUI open.${opened.warning ? ` ${opened.warning}` : " If no browser appeared, open this URL on this machine or forward its port over SSH."}`);
      } catch {
        return result(false, "Observer could not start — try humanish observe --run with this run's id in another terminal");
      }
    },
    close() {
      closed = true;
      closePromise ??= (async () => {
        // A close racing startup still awaits and releases the listener it owns.
        const server = await serverPromise?.catch(() => undefined);
        await server?.close();
      })();
      return closePromise;
    }
  };
}


/**
 * Stop a run that is still going.
 *
 * The counterpart to starting one: a study that is going nowhere costs money every turn, and until
 * now the only way to end it was to find the pid yourself.
 *
 * It signals the PROCESS GROUP, not the process. A run is spawned detached — its own group — and it
 * has children: the CLI, and whatever it spawned to reach the sandbox. Signalling only the parent
 * leaves those orphaned and still working.
 *
 * SIGTERM, never SIGKILL: the run's own handlers get the chance to finalize its record and release
 * what it holds. A killed run leaves a `running` record to go stale, which reads as interrupted —
 * true, but strictly less informative than a run that was told to stop.
 *
 * This stops the PROCESS. Sandboxes it created are a separate resource with their own receipts, and
 * `Reclaim` is what stops those — the run screen offers it as soon as this succeeds.
 */
export async function stopRun(cwd: string, runId: string): Promise<TuiActionResult> {
  const runPaths = await resolveRunPath(path.resolve(cwd), runId).catch(() => null);
  if (runPaths === null) {
    return { schema: TUI_ACTION_SCHEMA, ok: false, message: `no run directory for ${runId}` };
  }

  let record: unknown;
  try {
    record = JSON.parse(await readFile(path.join(runPaths.absoluteRunRoot, RUN_STATUS_FILE), "utf8"));
  } catch {
    return {
      schema: TUI_ACTION_SCHEMA,
      ok: false,
      message: "this run has no status record, so there is no pid to stop — it predates the contract or never started"
    };
  }
  if (!isRunStatusRecord(record)) {
    return { schema: TUI_ACTION_SCHEMA, ok: false, message: "this run's status record is unreadable" };
  }
  if (record.state === "finished") {
    return { schema: TUI_ACTION_SCHEMA, ok: false, message: "this run already finished" };
  }

  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    // pid 1 and below are never a run of ours, and signalling them would be catastrophic.
    return { schema: TUI_ACTION_SCHEMA, ok: false, message: "this run recorded no usable pid" };
  }

  // Is it actually still there? A pid whose process is already gone means the run died without
  // finalizing — nothing to stop, and the record will read as interrupted on its own.
  try {
    process.kill(pid, 0);
  } catch {
    return {
      schema: TUI_ACTION_SCHEMA,
      ok: false,
      message: `nothing is running under pid ${pid} — it has already stopped, and its record will read as interrupted`
    };
  }

  try {
    // Negative pid = the whole process group, which is why the run was spawned detached.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch (cause) {
      return {
        schema: TUI_ACTION_SCHEMA,
        ok: false,
        message: `could not stop it: ${cause instanceof Error ? cause.message : String(cause)}`
      };
    }
  }
  return {
    schema: TUI_ACTION_SCHEMA,
    ok: true,
    message: "asked the run to stop — its sandboxes are separate, so Reclaim them once it reports interrupted"
  };
}
