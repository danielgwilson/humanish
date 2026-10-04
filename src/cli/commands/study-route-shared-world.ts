import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { resolveStudyDryRun } from "../../study/plan.js";
import type { ConcurrentSharedWorldStudyResult } from "../../routes/shared-world/types.js";
import type { StudyConfig } from "../../study/types.js";
import { serveObserver } from "../../observer/render.js";
import type { ObserverResult, ObserverServer } from "../../observer/render.js";
import { redactText } from "../../evidence/redaction.js";
import { cliAnalysisOptions } from "./analysis-signals.js";
import {
  type CliIo,
  type StudyCommandOptions,
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
import { writeRunFindings } from "../findings.js";
import { formatConcurrentSharedWorldStudyHuman } from "./study-format.js";
import { resolveRouteShouldOpen, watchFinishedPlan } from "./study-route-open.js";
import type { RouteRun } from "./study-route-run.js";
import { rosterOf } from "../../study/parse/actors.js";
import { studyResultIdentity } from "../../run/study-result.js";

interface SharedWorldRouteArgs {
  command: Command;
  io: CliIo;
  config: StudyConfig;
  mode: "run" | "watch";
  options: StudyCommandOptions;
}

/**
 * The shared-world route's CLI setup: dry run, open and follow semantics, the live Observer server
 * the run attaches, and how it presents the outcome. Undefined when setup has already written its
 * own result.
 */
export function sharedWorldRouteRun(args: SharedWorldRouteArgs): RouteRun | undefined {
  const wantsMachine = wantsJson(args.command);
  const dryRun = resolveStudyDryRun(args.config, args.options.dryRun, true) ?? true;
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
    const result: ConcurrentSharedWorldStudyResult = {
      ...studyResultIdentity("shared-world", args.config.id),
      ok: false,
      cwd: args.options.cwd,
      actor: args.config.actors[0]?.type ?? "",
      topology: "shared-world",
      topologyMode: "concurrent",
      roleCount: rosterOf(args.config.actors[0])?.length ?? 0,
      concurrency: args.config.execution?.concurrency ?? 1,
      dryRun,
      runId: runId ?? args.options.runId ?? "not-created",
      roles: [],
      warnings: [],
      error: { code: "HUMANISH_SHARED_WORLD_FAILED", message },
    };
    writeResult(args.command, args.io, result, formatConcurrentSharedWorldStudyHuman);
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
      let output: ConcurrentSharedWorldStudyResult = result;
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
      writeResult(args.command, args.io, output, formatConcurrentSharedWorldStudyHuman);
      args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);
      await writeRunFindings(args.command, args.io, args.options.cwd, result);

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
