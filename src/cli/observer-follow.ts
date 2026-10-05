import { Command } from "commander";
import { serveObserver } from "../observer/render.js";
import type { ObserverResult, ObserverServer } from "../observer/render.js";
import type { ExposureRequest } from "../observer/exposure.js";
import { detectAgentSession } from "../actors/agent-session.js";
import type { RunResult } from "../run/results.js";
import {
  type CliIo,
  formatRunHuman,
  type StudyCommandOptions,
  parseObserverPort,
  wantsJson,
  writeResult,
  type HumanOutput,
  humanError,
} from "./io.js";

/** How a command shows an Observer, decided before the run it shows starts. */
export interface ObserverPlan {
  port: number;
  /** Open the page: the served URL when following, the static file otherwise. */
  shouldOpen: boolean;
  wantsFollow: boolean;
  /** Set when the command would have followed, but nobody is at a terminal to stop it. */
  unattended?: boolean;
}

/**
 * Whether a person can stop a served Observer: stdin and stdout are terminals, and no agent runner
 * claims the session. An agent's shell or a pipe has nobody to press Ctrl-C, so a server there
 * waits forever. A TTY alone is not enough, since Codex gives the commands it runs a terminal.
 */
export function personAtTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    detectAgentSession(env) === undefined
  );
}

/** Whether `watch` or `observe` serves the Observer and stays attached. */
export function followDecision(args: {
  wantsMachine: boolean;
  detach?: boolean | undefined;
  serve?: boolean | undefined;
}): { follow: boolean; unattended: boolean } {
  if (args.detach === true) return { follow: false, unattended: false };
  if (args.serve === true) return { follow: true, unattended: false };
  if (args.wantsMachine) return { follow: false, unattended: false };
  const attended = personAtTerminal();
  return { follow: attended, unattended: !attended };
}

/**
 * The warning a command adds when it printed the Observer and exited because nobody was attached.
 * It names the reason personAtTerminal found: an agent runner's marker, which can sit beside a real
 * terminal, or no terminal at all.
 */
export function unattendedObserverWarning(
  command: "watch" | "observe",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const agent = detectAgentSession(env);
  const reason =
    agent === undefined
      ? "No interactive terminal"
      : `An agent environment was detected (${agent.marker} is set, which ${agent.runner} sets)`;
  return `${reason}, so ${command} printed the Observer path and exited instead of serving it until Ctrl-C. Pass --serve to keep serving, or open the file.`;
}

/**
 * Parse --port and decide open and follow. On an invalid port it writes the failure, sets exit
 * code 2 and returns null, so a caller refuses before starting a run.
 */
export function planObserver(args: {
  command: Command;
  cwd: string;
  detach?: boolean | undefined;
  io: CliIo;
  open?: boolean | undefined;
  port: string;
  serve?: boolean | undefined;
}): ObserverPlan | null {
  const port = parseObserverPort(args.port);
  if (port === null) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: args.cwd,
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_PORT",
        message: "--port must be an integer between 0 and 65535.",
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return null;
  }
  const wantsMachine = wantsJson(args.command);
  const shouldOpen =
    args.open === false
      ? false
      : args.open === true
        ? true
        : !wantsMachine && process.stdout.isTTY === true;
  const decision = followDecision({ wantsMachine, detach: args.detach, serve: args.serve });
  return {
    port,
    shouldOpen,
    wantsFollow: decision.follow,
    ...(decision.unattended ? { unattended: true } : {}),
  };
}

/** The `open` a run's static Observer render takes: a followed Observer opens its served URL. */
export function staticObserverOpen(plan: ObserverPlan): boolean {
  return plan.wantsFollow ? false : plan.shouldOpen;
}

/** Write a rendered Observer's result, then serve and follow it when the plan says so. */
export async function showObserver(args: {
  command: Command;
  io: CliIo;
  plan: ObserverPlan;
  rendered: ObserverResult;
}): Promise<void> {
  const { plan, rendered } = args;
  let server: ObserverServer | null = null;
  let result = rendered;
  if (rendered.ok && plan.wantsFollow) {
    server = await serveObserver(rendered, { open: plan.shouldOpen, port: plan.port });
    result = withObserverServer(rendered, server);
  } else if (rendered.ok && plan.unattended === true) {
    result = { ...rendered, warnings: [...rendered.warnings, unattendedObserverWarning("watch")] };
  }
  writeResult(args.command, args.io, result, formatObserverHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (result.ok && server) {
    await followObserver(args.io, result, server);
  }
}

export function withObserverServer(
  rendered: ObserverResult,
  server: ObserverServer,
): ObserverResult {
  return {
    ...rendered,
    observerUrl: server.url,
    serverUrl: server.url,
    opened: server.opened,
    ...(server.openCommand ? { openCommand: server.openCommand } : {}),
    warnings: [
      ...rendered.warnings,
      "Live observer server is polling observer-data.json with no-store caching.",
      ...(server.warning ? [server.warning] : []),
    ],
  };
}

export function formatObserverHuman(result: ObserverResult): HumanOutput {
  if (!result.ok) return humanError(result.error);

  return (
    [
      "humanish observer rendered",
      `run: ${result.run}`,
      `observer: ${result.observerPath}`,
      ...(result.observerUrl ? [`url: ${result.observerUrl}`] : []),
      ...(result.opened === undefined ? [] : [`opened: ${result.opened ? "yes" : "no"}`]),
      `bundle: ${result.bundlePath}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

export type WatchStopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface WatchSignalTarget {
  once(event: WatchStopSignal, listener: () => void): unknown;
  removeListener(event: WatchStopSignal, listener: () => void): unknown;
}

export async function followObserver(
  io: CliIo,
  result: ObserverResult,
  server: ObserverServer,
  options: {
    onStop?: () => Promise<string[]>;
    signalTarget?: WatchSignalTarget;
    signals?: WatchStopSignal[];
  } = {},
): Promise<void> {
  io.writeOut(`watching: ${result.serverUrl ?? result.observerUrl ?? result.observerPath}\n`);
  io.writeOut("watching: press Ctrl-C to stop\n");
  await new Promise<void>((resolve) => {
    const signalTarget = options.signalTarget ?? process;
    const signals = options.signals ?? ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<WatchStopSignal, () => void>();
    let stopping = false;

    const stop = (signal: WatchStopSignal) => {
      if (stopping) {
        return;
      }

      stopping = true;
      for (const [registeredSignal, handler] of handlers.entries()) {
        signalTarget.removeListener(registeredSignal, handler);
      }
      io.setExitCode(exitCodeForSignal(signal));

      void (async () => {
        try {
          await server.close();
        } catch (error: unknown) {
          io.writeErr(
            `watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }

        if (options.onStop) {
          try {
            const messages = await options.onStop();
            for (const message of messages) {
              io.writeOut(`watch cleanup: ${message}\n`);
            }
          } catch (error: unknown) {
            io.writeErr(
              `watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }

        io.writeOut("watch stopped\n");
        resolve();
      })();
    };

    for (const signal of signals) {
      const handler = () => stop(signal);
      handlers.set(signal, handler);
      signalTarget.once(signal, handler);
    }
  });
}

export function exitCodeForSignal(signal: WatchStopSignal): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGHUP":
      return 129;
  }
}

// True when any tunnel-edge exposure flag is present (not --safe, which is an orthogonal filter).
// Callers refuse exposure with it on the watch path without a study and on non-computer-use routes, where
// there is no live desktop to stream.
export function watchExposeRequested(o: {
  expose?: boolean | undefined;
  tunnel?: string | undefined;
  tunnelDomain?: string | undefined;
  oauth?: string | undefined;
  allowEmail?: string[] | undefined;
  allowDomain?: string[] | undefined;
  publicUrl?: string | undefined;
}): boolean {
  return (
    o.expose === true ||
    o.tunnel !== undefined ||
    o.tunnelDomain !== undefined ||
    o.oauth !== undefined ||
    (o.allowEmail?.length ?? 0) > 0 ||
    (o.allowDomain?.length ?? 0) > 0 ||
    o.publicUrl !== undefined
  );
}

// Map StudyCommandOptions onto the shared exposure validator input.
export function exposureRequestFromOptions(options: StudyCommandOptions): ExposureRequest {
  return {
    expose: options.expose === true,
    ...(options.tunnel === undefined ? {} : { tunnel: options.tunnel }),
    ...(options.tunnelDomain === undefined ? {} : { tunnelDomain: options.tunnelDomain }),
    ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    allowEmails: options.allowEmail ?? [],
    allowDomains: options.allowDomain ?? [],
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    safe: options.safe === true,
  };
}
