import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { runLab, resolveLabDryRun } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import { CUA_ACTOR_LAB_SCHEMA } from "../../routes/computer-use/types.js";
import type { CuaActorLabErrorCode, CuaActorLabResult } from "../../routes/computer-use/types.js";
import type { ConcurrentSharedWorldLabResult } from "../../routes/shared-world/types.js";
import type { LabConfig } from "../../lab/types.js";
import { serveObserver } from "../../observer/render.js";
import type { ObserverResult, ObserverServer } from "../../observer/render.js";
import { startExposedObserver, validateExposure } from "../../observer/exposure.js";
import type { ExposurePlan } from "../../observer/exposure.js";
import { ServeTunnelError } from "../../observer/tunnel.js";
import { redactText } from "../../evidence/redaction.js";
import type { ServeTunnel } from "../../observer/tunnel.js";
import type { RunResult } from "../../run/results.js";
import { cliAnalysisOptions, type LoadedAdapterScorer } from "./lab-hooks.js";
import {
  type CliIo,
  formatRunHuman,
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
import {
  formatConcurrentSharedWorldLabHuman,
  formatCuaLabHuman,
  formatScriptedLabHuman,
  formatTerminalLabHuman,
} from "./lab-format.js";

export async function runSyntheticBackend(args: {
  command: Command;
  io: CliIo;
  lab: string;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const simCount = parseLabCount(args.options.sims, args.config.actors[0]?.count ?? 4);
  if (simCount === null) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: args.options.cwd,
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer.",
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  // `run` renders the Observer too, so `run` and `watch` write the same bundle and the first
  // `export` of a run bundle finds observer/index.html (#597). A render failure is a warning on the
  // result, never a failed run. The preview renders through its finished run, so the page shown is
  // the run just written, never a directory swapped in under its id.
  const openOverride = args.options.open ?? args.config.defaults?.open;
  const plan =
    args.mode === "watch"
      ? planObserver({
          command: args.command,
          cwd: args.options.cwd,
          io: args.io,
          port: args.options.port ?? "0",
          ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
          ...(openOverride === undefined ? {} : { open: openOverride }),
        })
      : undefined;
  if (plan === null) return;
  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    count: simCount,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    open: plan === undefined ? false : staticObserverOpen(plan),
  });
  if (outcome.backend !== "synthetic") {
    throw new Error(`Expected synthetic backend, got ${outcome.backend}.`);
  }
  const runResult = outcome.result;

  if (plan === undefined) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(runResult.ok ? 0 : 2);
    return;
  }

  if (!runResult.ok || runResult.observer === undefined) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  await showObserver({ command: args.command, io: args.io, plan, rendered: runResult.observer });
}

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

// Mirror of runCuaBackend: open semantics from defaults.open/--no-open/watch-mode, writeResult
// with the scripted human formatter, exit code result.ok ? 0 : 2, watch-mode Observer follow.
export async function runScriptedBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine,
  });
  const finishedPlan = watchFinishedPlan(args, wantsMachine, shouldOpen);
  if (finishedPlan === null) return;

  const outcome = await runLab(args.config, {
    ...cliAnalysisOptions(args.io),
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    open: observerOpen(args.mode, finishedPlan, shouldOpen),
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
  });
  if (outcome.backend !== "scripted") {
    throw new Error(`Expected scripted backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatScriptedLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  // Watch mode serves the Observer the route rendered through its finished run.
  if (finishedPlan !== undefined && result.ok && result.observer !== undefined) {
    await showObserver({
      command: args.command,
      io: args.io,
      plan: finishedPlan,
      rendered: result.observer,
    });
  }
}

// Mirror of runCuaBackend/runScriptedBackend: open semantics from defaults.open/--no-open/watch,
// writeResult with the terminal human formatter, exit code result.ok ? 0 : 2, watch-mode follow.
export async function runTerminalBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine,
  });
  const finishedPlan = watchFinishedPlan(args, wantsMachine, shouldOpen);
  if (finishedPlan === null) return;

  const outcome = await runLab(args.config, {
    ...cliAnalysisOptions(args.io),
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    open: observerOpen(args.mode, finishedPlan, shouldOpen),
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    ...(args.scorer
      ? {
          scorer: args.scorer.hooks,
          scorerProvenance: args.scorer.provenance,
        }
      : {}),
  });
  if (outcome.backend !== "terminal") {
    throw new Error(`Expected terminal backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatTerminalLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  if (finishedPlan !== undefined && result.ok && result.observer !== undefined) {
    await showObserver({
      command: args.command,
      io: args.io,
      plan: finishedPlan,
      rendered: result.observer,
    });
  }
}

/**
 * The Observer plan of a watch that shows the route's final render: undefined outside watch or in
 * machine mode, null after an invalid --port was reported.
 */
function watchFinishedPlan(
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
function observerOpen(
  mode: "run" | "watch",
  finishedPlan: ObserverPlan | undefined,
  shouldOpen: boolean,
): boolean {
  if (mode === "run") return shouldOpen;
  return finishedPlan === undefined ? false : staticObserverOpen(finishedPlan);
}

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
