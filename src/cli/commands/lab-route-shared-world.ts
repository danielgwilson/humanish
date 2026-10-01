import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { resolveLabDryRun } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { ConcurrentSharedWorldLabResult } from "../../routes/shared-world/types.js";
import type { LabConfig } from "../../lab/types.js";
import { serveObserver } from "../../observer/render.js";
import type { ObserverResult, ObserverServer } from "../../observer/render.js";
import { redactText } from "../../evidence/redaction.js";
import { cliAnalysisOptions } from "./lab-hooks.js";
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
import { resolveRouteShouldOpen, watchFinishedPlan } from "./lab-route-open.js";
import type { RouteRun } from "./lab-route-run.js";

interface SharedWorldRouteArgs {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}

/**
 * The shared-world route's CLI setup: dry run, open and follow semantics, the live Observer server
 * the run attaches, and how it presents the outcome. Undefined when setup has already written its
 * own result.
 */
export function sharedWorldRouteRun(args: SharedWorldRouteArgs): RouteRun | undefined {
  const wantsMachine = wantsJson(args.command);
  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, true) ?? true;
  const shouldOpen = resolveRouteShouldOpen({
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
    return undefined;
  }
  // A watch that does not follow the live run shows the Observer the route rendered through its
  // finished run once the run ends, never a re-render by run id.
  const finishedPlan = wantsFollow ? undefined : watchFinishedPlan(args, wantsMachine, shouldOpen);
  if (finishedPlan === null) return undefined;

  let server: ObserverServer | null = null;
  let attachedObserver: (ObserverResult & { ok: true }) | null = null;
  // Set when the live Observer itself failed to start: an operator-side failure, reported as a
  // structured result rather than an unexpected error.
  let observerFailure: unknown;
  return {
    options: {
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
    },
    onRunError: async (error) => {
      await server?.close().catch((cleanupError: unknown) => {
        args.io.writeErr(
          `watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      });
      server = null;
      if (observerFailure !== undefined && error === observerFailure) {
        const message = redactText(error instanceof Error ? error.message : String(error));
        failConcurrent(
          `The live Observer could not start, so the run stopped before its participants: ${message}`,
          attachedObserver?.run,
        );
        return;
      }
      throw error;
    },
    present: async (outcome) => {
      if (outcome.route !== "shared-world") {
        throw new Error(`Expected the shared-world route, got ${outcome.route}.`);
      }
      const result = outcome.result;
      let output: ConcurrentSharedWorldLabResult = result;
      if (server && attachedObserver) {
        output = {
          ...result,
          observer: result.observer?.ok
            ? withObserverServer(result.observer, server)
            : withObserverServer(attachedObserver, server),
          warnings: [
            ...result.warnings,
            "Live concurrent shared-world server is polling observer-data.json with no-store caching.",
            ...(server.warning ? [server.warning] : []),
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
    },
  };
}
