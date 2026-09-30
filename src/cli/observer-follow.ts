import { Command } from "commander";
import { renderObserver, serveObserver } from "../observer/render.js";
import type { ObserverResult, ObserverServer } from "../observer/render.js";
import type { ExposureRequest } from "../observer/exposure.js";
import type { RunResult } from "../run/results.js";
import {
  type CliIo,
  formatRunHuman,
  type LabCommandOptions,
  parseObserverPort,
  wantsJson,
  writeResult,
} from "./io.js";

/**
 * Write observer/index.html for a finished run the way `watch` does, so a bundle is the same
 * bundle whichever command produced it (#597). Never fails the run: a bundle without its Observer
 * is still evidence, and `export` can render one later.
 */
export async function renderObserverForRun(cwd: string, result: RunResult): Promise<void> {
  if (!result.ok || result.runId === undefined) return;
  try {
    const rendered = await renderObserver(cwd, result.runId, { open: false });
    if (!rendered.ok)
      result.warnings.push(
        `observer/index.html was not written: ${rendered.error?.message ?? "render failed"}`,
      );
  } catch (error) {
    result.warnings.push(
      `observer/index.html was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function renderAndMaybeFollowObserver(args: {
  command: Command;
  cwd: string;
  detach?: boolean | undefined;
  io: CliIo;
  open?: boolean | undefined;
  port: string;
  runInput: string;
}): Promise<void> {
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
    return;
  }

  const wantsMachine = wantsJson(args.command);
  const shouldOpen =
    args.open === false
      ? false
      : args.open === true
        ? true
        : !wantsMachine && process.stdout.isTTY === true;
  const wantsFollow = !wantsMachine && args.detach !== true;
  const rendered = await renderObserver(args.cwd, args.runInput, {
    open: wantsFollow ? false : shouldOpen,
  });
  let server: ObserverServer | null = null;
  let result = rendered;
  if (rendered.ok && wantsFollow) {
    server = await serveObserver(rendered, { open: shouldOpen, port });
    result = withObserverServer(rendered, server);
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

export function formatObserverHuman(result: ObserverResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

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
// Used to refuse exposure on the non-lab watch path and on non-CUA backends, where there is no live
// desktop to stream.
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

// Map LabCommandOptions onto the shared exposure validator input.
export function exposureRequestFromOptions(options: LabCommandOptions): ExposureRequest {
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
