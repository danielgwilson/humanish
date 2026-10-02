import type { RunLabOptions } from "../../run-lab.js";
import type { CliIo } from "../io.js";
import { handOverRunSignals } from "./run-signals.js";

/**
 * Post-run analysis cancellation for the CLI: while analysis runs, SIGINT, SIGTERM and SIGHUP abort
 * it. The listeners exist only during analysis; before it, the run's own handlers
 * (run-signals.ts) hold the signals and hand them over here.
 */
export function cliAnalysisOptions(
  io: Pick<CliIo, "writeErr">,
): Pick<RunLabOptions, "onEvent" | "analysisSignal"> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  return {
    analysisSignal: controller.signal,
    onEvent: (event) => {
      if (event.type === "analysis-started") {
        io.writeErr("Participants finished; preparing analysis…\n");
        handOverRunSignals();
        for (const signal of signals) process.on(signal, cancel);
      } else if (event.type === "analysis-finished") {
        for (const signal of signals) process.off(signal, cancel);
      }
    },
  };
}
