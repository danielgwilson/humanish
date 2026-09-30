import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { runLab, resolveLabDryRun } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import { CUA_ACTOR_LAB_SCHEMA } from "../../routes/computer-use/types.js";
import type { CuaActorLabErrorCode, CuaActorLabResult } from "../../routes/computer-use/types.js";
import type { LabConfig } from "../../lab/types.js";
import { serveObserver } from "../../observer/render.js";
import type { ObserverResult, ObserverServer } from "../../observer/render.js";
import { startExposedObserver, validateExposure } from "../../observer/exposure.js";
import type { ExposurePlan } from "../../observer/exposure.js";
import { ServeTunnelError } from "../../observer/tunnel.js";
import type { ServeTunnel } from "../../observer/tunnel.js";
import { cliAnalysisOptions, type LoadedAdapterScorer } from "./lab-hooks.js";
import {
  type CliIo,
  type LabCommandOptions,
  parseLabCount,
  parseLaneIds,
  parseObserverPort,
  wantsJson,
  writeResult,
} from "../io.js";
import {
  exposureRequestFromOptions,
  followObserver,
  type ObserverPlan,
  planObserver,
  showObserver,
  staticObserverOpen,
  withObserverServer,
} from "../observer-follow.js";
import { formatCuaLabHuman } from "./lab-format.js";
import { resolveBackendShouldOpen } from "./lab-backend-open.js";

export async function runCuaBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const settings = resolveCuaSettings(args);
  if (settings === undefined) return;
  const prepared = prepareCuaWatch(args, settings);
  if (prepared === undefined) return;
  const live: CuaLiveAttachment = {
    server: null,
    observer: null,
    tunnel: undefined,
    exposeWarnings: [],
    publicTarget: undefined,
  };
  const result = await runCuaLab(args, settings, prepared, live);
  if (result === undefined) return;
  await reportCuaRun(args, prepared, result, live);
}

type CuaBackendArgs = Parameters<typeof runCuaBackend>[0];

/** Parsed options for one CUA lab invocation. */
interface CuaRunSettings {
  wantsMachine: boolean;
  shouldOpen: boolean;
  laneIds: string[];
  count: number;
  dryRun: boolean;
  port: number;
  wantsFollow: boolean;
}

interface CuaWatchPlan {
  exposure: ExposurePlan;
  /** Set for a watch that shows the finished run's Observer instead of following it live. */
  finishedPlan: ObserverPlan | undefined;
}

/** The server, tunnel and Observer a followed watch attaches while the lab runs. */
interface CuaLiveAttachment {
  server: ObserverServer | null;
  observer: (ObserverResult & { ok: true }) | null;
  tunnel: ServeTunnel | undefined;
  exposeWarnings: string[];
  publicTarget: string | undefined;
}

function refuseCua(
  args: CuaBackendArgs,
  dryRun: boolean,
  code: CuaActorLabErrorCode,
  message: string,
): void {
  const result: CuaActorLabResult = {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd: args.options.cwd,
    labId: args.config.id,
    actor: args.config.actors[0]?.type ?? "",
    appUrl: "",
    dryRun,
    runId: args.options.runId ?? "not-created",
    warnings: [],
    error: { code, message },
  };
  writeResult(args.command, args.io, result, formatCuaLabHuman);
  args.io.setExitCode(2);
}

/** Parses the options, or writes the refusal and returns undefined. */
function resolveCuaSettings(args: CuaBackendArgs): CuaRunSettings | undefined {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine,
  });
  const laneIds = parseLaneIds(args.options.lanes);
  if (laneIds.length > 0 && !args.options.rerunFailedFrom) {
    args.io.writeErr("error: --lanes requires --rerun-failed-from.\n");
    args.io.setExitCode(2);
    return undefined;
  }
  const count = parseLabCount(
    args.options.count ?? args.options.sims,
    args.config.actors[0]?.count ?? 1,
  );
  if (count === null) {
    args.io.writeErr("error: --count/--sims must be a positive integer.\n");
    args.io.setExitCode(2);
    return undefined;
  }

  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, true) ?? true;
  const port = parseObserverPort(args.options.port ?? "0");
  const wantsFollow =
    args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;
  if (port === null) {
    refuseCua(
      args,
      dryRun,
      "HUMANISH_WATCH_OPTION_CONFLICT",
      "--port must be an integer between 0 and 65535.",
    );
    return undefined;
  }
  return { wantsMachine, shouldOpen, laneIds, count, dryRun, port, wantsFollow };
}

/** Validates exposure and plans the finished-run Observer, or returns undefined after refusing. */
function prepareCuaWatch(args: CuaBackendArgs, settings: CuaRunSettings): CuaWatchPlan | undefined {
  // Validate exposure up front (fail-closed matrix), before any run/spend. A live CUA watch is the
  // one surface that serves runtime E2B stream URLs, so it MUST sit behind edge auth.
  const exposeValidation = validateExposure("watch", exposureRequestFromOptions(args.options), {
    dryRun: settings.dryRun,
    detach: args.options.detach === true,
    json: settings.wantsMachine,
  });
  if (!exposeValidation.ok) {
    refuseCua(
      args,
      settings.dryRun,
      exposeValidation.error.code as CuaActorLabErrorCode,
      exposeValidation.error.message,
    );
    return undefined;
  }
  // A watch that does not follow the live run shows the Observer the route rendered through its
  // finished run once the run ends, never a re-render by run id.
  const finishedPlan =
    args.mode === "watch" && !settings.wantsMachine && !settings.wantsFollow
      ? planObserver({
          command: args.command,
          cwd: args.options.cwd,
          io: args.io,
          port: args.options.port ?? "0",
          open: settings.shouldOpen,
          ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
        })
      : undefined;
  if (finishedPlan === null) return undefined;
  return { exposure: exposeValidation.plan, finishedPlan };
}

/**
 * Runs the lab. Resolves to undefined after reporting a tunnel startup failure; the live server
 * and tunnel are closed before that report or any rethrow.
 */
async function runCuaLab(
  args: CuaBackendArgs,
  settings: CuaRunSettings,
  prepared: CuaWatchPlan,
  live: CuaLiveAttachment,
): Promise<CuaActorLabResult | undefined> {
  const { finishedPlan } = prepared;
  let outcome: Awaited<ReturnType<typeof runLab>>;
  try {
    outcome = await runLab(args.config, {
      ...cliAnalysisOptions(args.io),
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      // A followed watch opens the served Observer (or prints the phone target under --expose), so
      // its static render never opens. A non-follow watch opens what its plan says, once. Run mode
      // keeps the static open.
      open:
        args.mode === "watch"
          ? finishedPlan === undefined
            ? false
            : staticObserverOpen(finishedPlan)
          : settings.shouldOpen,
      count: settings.count,
      dryRun: settings.dryRun,
      ...(settings.wantsFollow
        ? {
            // Fires INSIDE runLab, before the actor loop and before sandbox creation, so a
            // tunnel-auth failure aborts before any spend and leaves no orphaned sandbox.
            onObserverReady: (observer: ObserverResult & { ok: true }) =>
              attachLiveObserver(args.io, settings, prepared.exposure, live, observer),
          }
        : {}),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      ...(args.scorer
        ? { scorer: args.scorer.hooks, scorerProvenance: args.scorer.provenance }
        : {}),
      ...(args.options.rerunFailedFrom === undefined
        ? {}
        : {
            rerun: {
              sourceRunId: args.options.rerunFailedFrom,
              ...(settings.laneIds.length === 0 ? {} : { laneIds: settings.laneIds }),
            },
          }),
    });
  } catch (error) {
    // Tear down the loopback server and any tunnel started inside onObserverReady before rethrowing
    // (or surfacing a structured tunnel-startup failure). The sandbox is created AFTER
    // onObserverReady returns, so a tunnel failure here cannot orphan one.
    await live.server?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(
        `watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    });
    live.server = null;
    if (live.tunnel) {
      await live.tunnel.close().catch(() => undefined);
      live.tunnel = undefined;
    }
    if (error instanceof ServeTunnelError) {
      refuseCua(args, settings.dryRun, error.code, error.message);
      return undefined;
    }
    throw error;
  }

  if (outcome.backend !== "cua") {
    throw new Error(`Expected cua backend, got ${outcome.backend}.`);
  }
  return outcome.result;
}

/** Serves the live Observer and, under --expose, puts the planned edge in front of it. */
async function attachLiveObserver(
  io: CliIo,
  settings: CuaRunSettings,
  exposure: ExposurePlan,
  live: CuaLiveAttachment,
  observer: ObserverResult & { ok: true },
): Promise<void> {
  live.observer = observer;
  if (!live.server) {
    live.server = await serveObserver(observer, {
      open: settings.shouldOpen && !exposure.exposed,
      port: settings.port,
      exposed: exposure.exposed,
    });
  }
  if (exposure.exposed) {
    const activeServer = live.server;
    const exposeResult = await startExposedObserver(activeServer, exposure);
    if (exposeResult.tunnel) {
      live.tunnel = exposeResult.tunnel;
    }
    live.exposeWarnings = exposeResult.warnings;
    const phoneTarget = exposeResult.publicUrl ?? activeServer.url;
    live.publicTarget = phoneTarget;
    io.writeOut(
      `watch: exposed live desktop at ${phoneTarget} (edge-authed; open it on your phone)\n`,
    );
    for (const warning of exposeResult.warnings) {
      io.writeErr(`warning: ${warning}\n`);
    }
  }
}

/** Writes the result, then follows the live server or shows the finished run's Observer. */
async function reportCuaRun(
  args: CuaBackendArgs,
  prepared: CuaWatchPlan,
  result: CuaActorLabResult,
  live: CuaLiveAttachment,
): Promise<void> {
  const { server, observer: attachedObserver } = live;
  const exposeRequested = prepared.exposure.exposed;
  // Serving is NOT gated on result.ok: a timed_out/failed run still comes up so the operator can
  // inspect its evidence live (and, under --expose, from a phone). budget_reached now makes a
  // productive open-ended watch result.ok true.
  let output: CuaActorLabResult = result;
  if (server && attachedObserver) {
    const attachedResult = result.observer?.ok ? result.observer : attachedObserver;
    output = {
      ...result,
      observer: withObserverServer(attachedResult, server),
      warnings: [
        ...result.warnings,
        "Live CUA server is polling observer-data.json with no-store caching.",
        ...(exposeRequested
          ? [
              `Exposed live desktop stream URLs to an edge-authenticated remote viewer${live.tunnel ? ` via ${live.tunnel.url.replace(/\/$/, "")}` : ""}.`,
              `this live run's raw, unverified evidence (screenshots, events) is viewable by anyone who clears the edge auth at ${live.publicTarget ?? server.url}; only the run being watched is served, not your other runs`,
            ]
          : []),
        ...live.exposeWarnings,
        ...(server.warning ? [server.warning] : []),
      ],
    };
  }
  writeResult(args.command, args.io, output, formatCuaLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  if (server && (result.observer?.ok || attachedObserver)) {
    const followResult = output.observer?.ok
      ? output.observer
      : withObserverServer(attachedObserver!, server);
    await followObserver(args.io, followResult, server, {
      onStop: async () => {
        if (live.tunnel) {
          await live.tunnel.close();
          return ["closed ngrok tunnel"];
        }
        return [];
      },
    });
  } else if (prepared.finishedPlan !== undefined && result.ok && result.observer !== undefined) {
    await showObserver({
      command: args.command,
      io: args.io,
      plan: prepared.finishedPlan,
      rendered: result.observer,
    });
  }
}
