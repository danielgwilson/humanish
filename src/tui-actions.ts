// The two things a run card can DO (#455 rev 8).
//
// The mock's run screen is an outcome CARD with actions, not a field list, and an action that does
// nothing is worse than no action — so this ships the two that are genuinely implementable today
// and nothing else. `Share…` waits for the export contract (#471) rather than appearing as a
// control that fails.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

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
