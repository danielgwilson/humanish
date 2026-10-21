import { ANALYSIS_USUALLY_TAKES } from "../../analysis/analysis-limits.js";
import type { RunStudyOptions } from "../../run-study.js";
import { systemHostClock, type HostClock } from "../../run/host-suspension.js";
import { formatDuration } from "../../run/projection.js";
import type { CliIo } from "../io.js";
import { cli } from "../invocation.js";
import { handOverRunSignals } from "./run-signals.js";

/** How often a human sees how long analysis has run: often enough to look alive, rarely enough
 *  to read as one line per glance. */
const ANALYSIS_PROGRESS_MS = 20_000;

/**
 * The CLI's run events. When the run starts, one stderr line names it and the command that
 * follows it. While analysis runs, SIGINT, SIGTERM and SIGHUP abort it; the listeners exist only
 * during analysis, since before it the run's own handlers (run-signals.ts) hold the signals and
 * hand them over here. A human also gets a line when analysis starts and one with its elapsed
 * time every 20 s; `--json` gets only the first line, on stderr, so stdout stays one result.
 */
export function cliRunEventOptions(
  io: Pick<CliIo, "writeErr">,
  options: { json?: boolean; clock?: HostClock } = {},
): Pick<RunStudyOptions, "onEvent" | "analysisSignal"> {
  const clock = options.clock ?? systemHostClock;
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let stopProgress: (() => void) | undefined;
  return {
    analysisSignal: controller.signal,
    onEvent: (event) => {
      if (event.type === "run-started") {
        io.writeErr(
          `Run ${event.runId} started. Follow it with ${cli(`observe --run ${event.runId}`)}; ${cli("runs")} lists its state.\n`,
        );
      } else if (event.type === "analysis-started") {
        io.writeErr(
          `Participants finished. Writing findings; this usually takes ${ANALYSIS_USUALLY_TAKES}.\n`,
        );
        if (options.json !== true) {
          const startedMs = clock.now();
          stopProgress = clock.every(ANALYSIS_PROGRESS_MS, () => {
            io.writeErr(
              `Still writing findings: ${formatDuration(clock.now() - startedMs)} elapsed.\n`,
            );
          });
        }
        handOverRunSignals();
        for (const signal of signals) process.on(signal, cancel);
      } else if (event.type === "analysis-finished") {
        stopProgress?.();
        stopProgress = undefined;
        for (const signal of signals) process.off(signal, cancel);
      }
    },
  };
}
