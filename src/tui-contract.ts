// The boundary between the CLI and the terminal UI (#455).
//
// `humanish tui` loads a PRE-BUILT bundle (dist/tui-app.js) that contains Ink, React and the
// screens — and nothing else. Everything the surface needs to KNOW is passed across this interface
// by the CLI, which imports it from the same modules every other command uses.
//
// The reason for the seam: a terminal UI that reads the filesystem itself would become a second
// implementation of "what is a run, which lab does it belong to, is it alive" — one that ships
// minified, is invisible to the root test suite, and drifts from `humanish runs` the first time
// either side changes. Injection keeps exactly one implementation, already unit-tested, and leaves
// the bundle a view layer that can be reasoned about as one.
//
// It also makes the UI testable without a terminal: a test hands `startTui` a fake index and reads
// the frames back.

import type { LabListResult } from "./labs.js";
import type { LabSummary, ReadLabSummaryOptions } from "./lab-summary.js";
import type { RunDetail } from "./run-detail.js";
import type { ReclaimResult } from "./reclaim.js";
import type { TuiActionResult } from "./tui-actions.js";
import type { TuiProjectState } from "./tui-project.js";
import type { ReadRunIndexOptions, RunIndexResult } from "./run-index.js";
import type { LaunchRunOptions, LaunchRunResult } from "./tui-launch.js";

/** The humanish version string shown in the frame, so a screenshot in a bug report is datable. */
export interface TuiVersionInfo {
  cli: string;
}

/**
 * What the surface may do to the project. Deliberately a small, explicit list rather than a handle
 * to the whole library: the set of verbs a stakeholder surface can perform should be readable in
 * one place, and anything absent here is something the TUI simply cannot do.
 */
export interface TuiCapabilities {
  /** Read every run in the project, cheapest source first. */
  readRunIndex(cwd: string, options?: ReadRunIndexOptions): Promise<RunIndexResult>;
  /**
   * The labs DECLARED in this project. Listed separately from run history because neither side is
   * the whole truth: a fresh project has manifests and no runs, and a long-lived one has runs from
   * manifests since renamed or deleted.
   */
  listLabs(cwd: string): Promise<LabListResult>;
  /**
   * Start a run and return once it is running. The run is DETACHED: it outlives this surface, so
   * quitting the TUI — or losing the connection it runs over — does not kill a study that costs
   * real money. The surface then follows it through `status.json` like any other reader.
   */
  startRun(options: Omit<LaunchRunOptions, "spawn" | "cliPath" | "now">): Promise<LaunchRunResult>;
  /** The tail of a launch log: the only account of a run that died before writing evidence. */
  readLaunchLog(logPath: string): Promise<string>;
  /**
   * Who is in ONE run and what they are thinking. Opens that run's bundle, which the index
   * deliberately does not — affordable because it is asked only for the run being watched.
   * `null` when the run has not written a bundle yet.
   */
  readRunDetail(cwd: string, runId: string): Promise<RunDetail | null>;
  /**
   * What a lab IS — subject, participants, model, spend caps, and whether the keys a live run needs
   * resolve right now. Read for the lab being looked at, because it is what someone reads before
   * deciding to spend money.
   */
  readLabSummary(cwd: string, lab: string, options?: ReadLabSummaryOptions): Promise<LabSummary | null>;
  /** Whether this directory is a humanish project — an empty project and a wrong directory are
   *  different problems and must not share a screen. */
  readProjectState(cwd: string): TuiProjectState;
  /** Hand off to the Observer: a terminal cannot show screenshots, and that surface can. */
  openObserver(cwd: string, observerPath: string): Promise<TuiActionResult>;
  /** Stop the sandboxes an interrupted run left behind, keeping its evidence. */
  reclaimRun(cwd: string, runId: string): Promise<ReclaimResult>;
  /** End a run that is still going. Stops the PROCESS; `reclaimRun` stops what it provisioned. */
  stopRun(cwd: string, runId: string): Promise<TuiActionResult>;
}

export interface TuiOptions {
  /** The project the surface is reading. Already resolved by the CLI. */
  cwd: string;
  version: TuiVersionInfo;
  capabilities: TuiCapabilities;
  /**
   * Terminal streams, injected so a test can drive the surface without a real TTY. The CLI passes
   * the real ones; both are known to be TTYs by the time this is called, because the command
   * refuses to start otherwise.
   */
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** Test seam: render one frame and resolve, instead of waiting for the operator to quit. */
  exitAfterFirstFrame?: boolean;
}

/**
 * Start the surface. Resolves with the process exit code when the operator quits — the TUI owns the
 * screen until then, so the CLI must not write to stdout while this is pending.
 */
export type StartTui = (options: TuiOptions) => Promise<number>;

/** The shape `dist/tui-app.js` exports. Asserted at the load boundary in program.ts. */
export interface TuiModule {
  startTui: StartTui;
}

/** Node version the Ink runtime requires (ink@7 declares `engines.node >= 22`). */
export const TUI_MIN_NODE_MAJOR = 22;

/**
 * Whether this runtime can host the surface. Kept here, beside the reason, so the CLI's refusal and
 * `doctor`'s readiness row can never disagree about the answer.
 */
export function nodeSupportsTui(versionString: string = process.version): boolean {
  const major = Number.parseInt(versionString.replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= TUI_MIN_NODE_MAJOR;
}

/**
 * Where the bundle sits relative to the compiled CLI. Shared so the command that loads it and the
 * readiness row that reports it can never look in different places.
 */
export function tuiBundleUrl(baseUrl: string): URL {
  return new URL("./tui-app.js", baseUrl);
}

/**
 * What `doctor` says about the stakeholder surface — a pure function of the machine's state and,
 * crucially, of WHO IS READING.
 *
 * A real first-contact study (labs/first-contact.yaml) is why the reader matters. An autonomous
 * agent evaluating humanish read "`humanish tui` is available in an interactive terminal",
 * correctly concluded it was not in one, and dropped it — then wrote a report FOR A HUMAN that
 * never mentioned the human surface at all. Discovery worked and handoff did not. A capability
 * described to a reader who cannot use it has to be phrased as something to PASS ON, or it reads
 * as "not for you" and dies in the transcript.
 */
export function terminalSurfaceMessage(state: {
  supported: boolean;
  bundlePresent: boolean;
  interactive: boolean;
  nodeVersion: string;
}): string {
  if (!state.supported) {
    return `\`humanish tui\` needs Node ${TUI_MIN_NODE_MAJOR}+ (this is ${state.nodeVersion}); every other command works here`;
  }
  if (!state.bundlePresent) {
    return "`humanish tui` bundle is not built in this checkout — run `pnpm build` (installed packages ship it prebuilt)";
  }
  return state.interactive
    ? "`humanish tui` opens the interactive surface for browsing labs and runs"
    : "`humanish tui` is the interactive surface a PERSON uses to watch and start runs here — this shell is not a terminal, so pass it on to whoever is";
}
