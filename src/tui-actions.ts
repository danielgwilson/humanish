// The two things a run card can DO (#455 rev 8).
//
// The mock's run screen is an outcome CARD with actions, not a field list, and an action that does
// nothing is worse than no action — so this ships the two that are genuinely implementable today
// and nothing else. `Share…` waits for the export contract (#471) rather than appearing as a
// control that fails.

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { RUN_STATUS_FILE, isRunStatusRecord } from "./run-status.js";
import { resolveRunPath } from "./run.js";

export const TUI_ACTION_SCHEMA = "humanish.tui-action.v1";

export interface TuiActionResult {
  schema: typeof TUI_ACTION_SCHEMA;
  ok: boolean;
  /** What to tell the operator. Always set: an action that appears to do nothing is a bug. */
  message: string;
}

/** The platform's "open this file" command. */
function opener(): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  if (process.platform === "linux") return { command: "xdg-open", args: [] };
  return null;
}

/**
 * Open a run's self-contained Observer artifact in whatever the machine uses for HTML.
 *
 * A terminal cannot show screenshots, and this is the handoff to the surface that can. It fails
 * SOFTLY and usefully: over SSH there is no desktop to open anything, which is not an error — it
 * just means the answer is the path, so the operator can forward the port, scp the file, or open it
 * on the machine it lives on.
 */
export async function openObserverArtifact(cwd: string, observerPath: string): Promise<TuiActionResult> {
  const absolute = path.isAbsolute(observerPath) ? observerPath : path.join(path.resolve(cwd), observerPath);
  try {
    await access(absolute);
  } catch {
    return {
      schema: TUI_ACTION_SCHEMA,
      ok: false,
      message: `no Observer artifact at ${observerPath} — this run may not have finished writing one`
    };
  }

  const open = opener();
  if (open === null) {
    return { schema: TUI_ACTION_SCHEMA, ok: true, message: absolute };
  }
  try {
    const child = spawn(open.command, [...open.args, absolute], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // Swallowed deliberately: see below — the message already tells the operator the path, which
      // is the useful half whether or not a desktop existed to open it.
    });
    child.unref();
    return {
      schema: TUI_ACTION_SCHEMA,
      ok: true,
      // Says the path REGARDLESS. On a headless box `xdg-open` reports success and nothing appears,
      // so a message that only said "opened" would be a lie the operator cannot check.
      message: `opening ${observerPath} — if nothing appeared, open it yourself (headless or over SSH)`
    };
  } catch (cause) {
    return {
      schema: TUI_ACTION_SCHEMA,
      ok: false,
      message: `could not open it (${cause instanceof Error ? cause.message : String(cause)}) — the file is at ${absolute}`
    };
  }
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
