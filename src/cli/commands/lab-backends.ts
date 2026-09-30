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
import { ServeTunnelError } from "../../observer/tunnel.js";
import { redactText } from "../../evidence/redaction.js";
import type { ServeTunnel } from "../../observer/tunnel.js";
import type { RunResult } from "../../run/results.js";
import {
  browserScorerHooks,
  cliAutomaticAnalysisHooks,
  type LoadedAdapterScorer,
  terminalScorerHooks,
} from "./lab-hooks.js";
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
  renderAndMaybeFollowObserver,
  renderObserverForRun,
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

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    count: simCount,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
  });
  if (outcome.backend !== "synthetic") {
    throw new Error(`Expected synthetic backend, got ${outcome.backend}.`);
  }
  const runResult = outcome.result;

  if (args.mode === "run") {
    // `run` and `watch` used to disagree about whether a bundle has observer/index.html: watch
    // rendered it to serve it, run did not, and the first `export` of a run bundle failed (#597,
    // found by the 0.72.0 dogfood participant). Render it here too, so the two commands write the
    // same bundle; a render failure is a warning on the result, never a failed run.
    await renderObserverForRun(args.options.cwd, runResult);
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(runResult.ok ? 0 : 2);
    return;
  }

  if (!runResult.ok || !runResult.runId) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const openOverride = args.options.open ?? args.config.defaults?.open;
  await renderAndMaybeFollowObserver({
    command: args.command,
    cwd: args.options.cwd,
    io: args.io,
    port: args.options.port ?? "0",
    runInput: runResult.runId,
    ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
    ...(openOverride === undefined ? {} : { open: openOverride }),
  });
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
    return;
  }
  const count = parseLabCount(
    args.options.count ?? args.options.sims,
    args.config.actors[0]?.count ?? 1,
  );
  if (count === null) {
    args.io.writeErr("error: --count/--sims must be a positive integer.\n");
    args.io.setExitCode(2);
    return;
  }

  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, true) ?? true;
  const port = parseObserverPort(args.options.port ?? "0");
  const wantsFollow =
    args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;

  const failCua = (code: CuaActorLabErrorCode, message: string): void => {
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
  };

  if (port === null) {
    failCua("HUMANISH_WATCH_OPTION_CONFLICT", "--port must be an integer between 0 and 65535.");
    return;
  }

  // Validate exposure up front (fail-closed matrix), before any run/spend. A live CUA watch is the
  // one surface that serves runtime E2B stream URLs, so it MUST sit behind edge auth.
  const exposeValidation = validateExposure("watch", exposureRequestFromOptions(args.options), {
    dryRun,
    detach: args.options.detach === true,
    json: wantsMachine,
  });
  if (!exposeValidation.ok) {
    failCua(exposeValidation.error.code as CuaActorLabErrorCode, exposeValidation.error.message);
    return;
  }
  const plan = exposeValidation.plan;
  const exposeRequested = plan.exposed;

  let server: ObserverServer | null = null;
  let attachedObserver: (ObserverResult & { ok: true }) | null = null;
  let tunnel: ServeTunnel | undefined;
  let exposeWarnings: string[] = [];
  let exposePublicTarget: string | undefined;

  let outcome: Awaited<ReturnType<typeof runLab>>;
  try {
    outcome = await runLab(args.config, {
      automaticAnalysis: cliAutomaticAnalysisHooks(args.io),
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      // Watch mode opens the served Observer below (or prints the phone target under --expose)
      // instead of the static render — preserved byte-for-byte from the pre-0.18 open policy so a
      // non-follow watch (dry-run/--json) does not double-open. Run mode keeps the static open.
      open: args.mode === "watch" ? false : shouldOpen,
      count,
      dryRun,
      ...(wantsFollow
        ? {
            // Fires INSIDE runLab, before the actor loop and before sandbox creation, so a
            // tunnel-auth failure aborts before any spend and leaves no orphaned sandbox.
            onObserverReady: async (observer) => {
              attachedObserver = observer;
              if (!server) {
                server = await serveObserver(observer, {
                  open: shouldOpen && !exposeRequested,
                  port,
                  exposed: exposeRequested,
                });
              }
              if (exposeRequested) {
                const activeServer = server as ObserverServer;
                const exposeResult = await startExposedObserver(activeServer, plan);
                if (exposeResult.tunnel) {
                  tunnel = exposeResult.tunnel;
                }
                exposeWarnings = exposeResult.warnings;
                const phoneTarget = exposeResult.publicUrl ?? activeServer.url;
                exposePublicTarget = phoneTarget;
                args.io.writeOut(
                  `watch: exposed live desktop at ${phoneTarget} (edge-authed; open it on your phone)\n`,
                );
                for (const warning of exposeResult.warnings) {
                  args.io.writeErr(`warning: ${warning}\n`);
                }
              }
            },
          }
        : {}),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      ...(args.scorer
        ? { cuaHooks: browserScorerHooks(args.scorer), scorerProvenance: args.scorer.provenance }
        : {}),
      ...(args.options.rerunFailedFrom === undefined
        ? {}
        : {
            rerun: {
              sourceRunId: args.options.rerunFailedFrom,
              ...(laneIds.length === 0 ? {} : { laneIds }),
            },
          }),
    });
  } catch (error) {
    // Tear down the loopback server and any tunnel started inside onObserverReady before rethrowing
    // (or surfacing a structured tunnel-startup failure). The sandbox is created AFTER
    // onObserverReady returns, so a tunnel failure here cannot orphan one.
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(
        `watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    });
    server = null;
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
      tunnel = undefined;
    }
    if (error instanceof ServeTunnelError) {
      failCua(error.code, error.message);
      return;
    }
    throw error;
  }

  if (outcome.backend !== "cua") {
    throw new Error(`Expected cua backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;

  // Serving is NOT gated on result.ok: a timed_out/failed run still comes up so the operator can
  // inspect its evidence live (and, under --expose, from a phone). budget_reached now makes a
  // productive open-ended watch result.ok true.
  let output: CuaActorLabResult = result;
  if (server && attachedObserver) {
    const activeServer = server as ObserverServer;
    const attachedResult = result.observer?.ok ? result.observer : attachedObserver;
    output = {
      ...result,
      observer: withObserverServer(attachedResult, activeServer),
      warnings: [
        ...result.warnings,
        "Live CUA server is polling observer-data.json with no-store caching.",
        ...(exposeRequested
          ? [
              `Exposed live desktop stream URLs to an edge-authenticated remote viewer${tunnel ? ` via ${tunnel.url.replace(/\/$/, "")}` : ""}.`,
              `this live run's raw, unverified evidence (screenshots, events) is viewable by anyone who clears the edge auth at ${exposePublicTarget ?? activeServer.url}; only the run being watched is served, not your other runs`,
            ]
          : []),
        ...exposeWarnings,
        ...(activeServer.warning ? [activeServer.warning] : []),
      ],
    };
  }
  writeResult(args.command, args.io, output, formatCuaLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  if (server && (result.observer?.ok || attachedObserver)) {
    const activeServer = server as ObserverServer;
    const followResult = output.observer?.ok
      ? output.observer
      : withObserverServer(attachedObserver!, activeServer);
    await followObserver(args.io, followResult, activeServer, {
      onStop: async () => {
        if (tunnel) {
          await tunnel.close();
          return ["closed ngrok tunnel"];
        }
        return [];
      },
    });
  } else if (args.mode === "watch" && result.ok && !wantsMachine) {
    // Non-follow / dry-run watch keeps today's fallback: render the finished bundle and follow it.
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen }),
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

  const outcome = await runLab(args.config, {
    automaticAnalysis: cliAutomaticAnalysisHooks(args.io),
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    // Watch mode opens the served Observer below instead of the static render.
    open: args.mode === "watch" ? false : shouldOpen,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
  });
  if (outcome.backend !== "scripted") {
    throw new Error(`Expected scripted backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatScriptedLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  // Watch mode serves the freshly rendered Observer (and opens it unless told not to).
  if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen }),
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

  const outcome = await runLab(args.config, {
    automaticAnalysis: cliAutomaticAnalysisHooks(args.io),
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    open: args.mode === "watch" ? false : shouldOpen,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    ...(args.scorer
      ? {
          terminalHooks: terminalScorerHooks(args.scorer),
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

  if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen }),
    });
  }
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

  let server: ObserverServer | null = null;
  let attachedObserver: (ObserverResult & { ok: true }) | null = null;
  // Set when the live Observer itself failed to start: an operator-side failure, reported as a
  // structured result rather than an unexpected error.
  let observerFailure: unknown;
  let outcome: Awaited<ReturnType<typeof runLab>>;
  try {
    outcome = await runLab(args.config, {
      automaticAnalysis: cliAutomaticAnalysisHooks(args.io),
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      open: wantsFollow ? false : shouldOpen,
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
            sharedWorldHooks: browserScorerHooks(args.scorer),
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
  } else if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen }),
    });
  }
}
