import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { runLab, resolveLabDryRun } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { ConcurrentSharedWorldLabResult } from "../../routes/shared-world/types.js";
import type { LabConfig } from "../../lab/types.js";
import { serveObserver } from "../../observer/render.js";
import type { ObserverResult, ObserverServer } from "../../observer/render.js";
import { redactText } from "../../evidence/redaction.js";
import { cliAnalysisOptions, type LoadedAdapterScorer } from "./lab-hooks.js";
import {
  type CliIo,
  type LabCommandOptions,
  parseObserverPort,
  wantsJson,
  writeResult,
} from "../io.js";
import {
  followObserver,
  showObserver,
  staticObserverOpen,
  withObserverServer,
} from "../observer-follow.js";
import { formatConcurrentSharedWorldLabHuman } from "./lab-format.js";
import { resolveBackendShouldOpen, watchFinishedPlan } from "./lab-backend-open.js";

export async function runConcurrentSharedWorldBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, true) ?? true;
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine,
  });
  const wantsFollow =
    args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;
  const port = parseObserverPort(args.options.port ?? "0");
  const failConcurrent = (message: string, runId?: string): void => {
    const result: ConcurrentSharedWorldLabResult = {
      schema: "humanish.concurrent-shared-world-lab-result.v1",
      ok: false,
      cwd: args.options.cwd,
      labId: args.config.id,
      actor: args.config.actors[0]?.type ?? "",
      topology: "shared-world",
      topologyMode: "concurrent",
      roleCount: args.config.actors[0]?.lanes?.length ?? 0,
      concurrency: args.config.execution?.concurrency ?? 1,
      dryRun,
      runId: runId ?? args.options.runId ?? "not-created",
      roles: [],
      warnings: [],
      error: { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message },
    };
    writeResult(args.command, args.io, result, formatConcurrentSharedWorldLabHuman);
    args.io.setExitCode(2);
  };
  if (wantsFollow && port === null) {
    failConcurrent("--port must be an integer between 0 and 65535.");
    return;
  }
  // A watch that does not follow the live run shows the Observer the route rendered through its
  // finished run once the run ends, never a re-render by run id.
  const finishedPlan = wantsFollow ? undefined : watchFinishedPlan(args, wantsMachine, shouldOpen);
  if (finishedPlan === null) return;

  let server: ObserverServer | null = null;
  let attachedObserver: (ObserverResult & { ok: true }) | null = null;
  // Set when the live Observer itself failed to start: an operator-side failure, reported as a
  // structured result rather than an unexpected error.
  let observerFailure: unknown;
  let outcome: Awaited<ReturnType<typeof runLab>>;
  try {
    outcome = await runLab(args.config, {
      ...cliAnalysisOptions(args.io),
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      open: wantsFollow
        ? false
        : finishedPlan === undefined
          ? shouldOpen
          : staticObserverOpen(finishedPlan),
      dryRun,
      ...(wantsFollow
        ? {
            onObserverReady: async (observer) => {
              attachedObserver = observer;
              try {
                server ??= await serveObserver(observer, { open: shouldOpen, port: port ?? 0 });
              } catch (error) {
                observerFailure = error;
                throw error;
              }
            },
          }
        : {}),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      ...(args.scorer
        ? {
            scorer: args.scorer.hooks,
            scorerProvenance: args.scorer.provenance,
          }
        : {}),
    });
  } catch (error) {
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(
        `watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    });
    server = null;
    if (observerFailure !== undefined && error === observerFailure) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      failConcurrent(
        `The live Observer could not start, so the run stopped before its participants: ${message}`,
        (attachedObserver as (ObserverResult & { ok: true }) | null)?.run,
      );
      return;
    }
    throw error;
  }
  if (outcome.backend !== "concurrent-shared-world") {
    throw new Error(`Expected concurrent-shared-world backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  let output: ConcurrentSharedWorldLabResult = result;
  if (server && attachedObserver) {
    const activeServer = server as ObserverServer;
    output = {
      ...result,
      observer: result.observer?.ok
        ? withObserverServer(result.observer, activeServer)
        : withObserverServer(attachedObserver, activeServer),
      warnings: [
        ...result.warnings,
        "Live concurrent shared-world server is polling observer-data.json with no-store caching.",
        ...(activeServer.warning ? [activeServer.warning] : []),
      ],
    };
  }
  writeResult(args.command, args.io, output, formatConcurrentSharedWorldLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  if (server && output.observer?.ok) {
    await followObserver(args.io, output.observer, server);
  } else if (finishedPlan !== undefined && result.ok && result.observer !== undefined) {
    await showObserver({
      command: args.command,
      io: args.io,
      plan: finishedPlan,
      rendered: result.observer,
    });
  }
}
