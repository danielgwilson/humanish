import { Command } from "commander";
import type { CliIo, LabCommandOptions } from "../io.js";
import { type ObserverPlan, planObserver, staticObserverOpen } from "../observer-follow.js";

/**
 * Default browser-open policy for a lab backend run. Mirrors the observe/watch gate:
 * an explicit --open/--no-open wins; --json (machine mode) never auto-opens; otherwise a
 * lab-config `defaults.open` wins, and the final fallback opens only for an interactive
 * `watch` on a real TTY. Extracted so all lab backends share one gate (and one test).
 */
export function resolveBackendShouldOpen(args: {
  optionOpen: boolean | undefined;
  defaultsOpen: boolean | undefined;
  mode: string;
  wantsMachine: boolean;
}): boolean {
  if (args.optionOpen === false) return false;
  if (args.wantsMachine) return args.optionOpen === true;
  return (
    args.optionOpen ?? args.defaultsOpen ?? (process.stdout.isTTY === true && args.mode === "watch")
  );
}

/**
 * The Observer plan of a watch that shows the route's final render: undefined outside watch or in
 * machine mode, null after an invalid --port was reported.
 */
export function watchFinishedPlan(
  args: { command: Command; io: CliIo; mode: "run" | "watch"; options: LabCommandOptions },
  wantsMachine: boolean,
  shouldOpen: boolean,
): ObserverPlan | null | undefined {
  if (args.mode !== "watch" || wantsMachine) return undefined;
  return planObserver({
    command: args.command,
    cwd: args.options.cwd,
    io: args.io,
    port: args.options.port ?? "0",
    open: shouldOpen,
    ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
  });
}

/** The route's static render opens only when nothing else will open the Observer. */
export function observerOpen(
  mode: "run" | "watch",
  finishedPlan: ObserverPlan | undefined,
  shouldOpen: boolean,
): boolean {
  if (mode === "run") return shouldOpen;
  return finishedPlan === undefined ? false : staticObserverOpen(finishedPlan);
}
