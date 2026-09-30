import { Command, Option } from "commander";
import { openTarget, renderObserver, serveObserver } from "../../observer/render.js";
import type { ObserverResult } from "../../observer/render.js";
import { SERVE_SCHEMA, serveObserverLibrary } from "../../observer/serve.js";
import type { ServeErrorCode, ServeResult } from "../../observer/serve.js";
import { startExposedObserver, validateExposure } from "../../observer/exposure.js";
import { ServeTunnelError } from "../../observer/tunnel.js";
import type { ServeTunnel } from "../../observer/tunnel.js";
import type { RunResult } from "../../run/results.js";
import {
  type CliIo,
  collectRepeated,
  formatRunHuman,
  JSON_OPTION_DESCRIPTION,
  parseObserverPort,
  wantsJson,
  writeResult,
} from "../io.js";
import {
  exitCodeForSignal,
  formatObserverHuman,
  type WatchStopSignal,
} from "../observer-follow.js";

export function registerObserveCommand(parent: Command, io: CliIo): void {
  parent
    .command("observe")
    .description("Follow a run's saved evidence in Observer over loopback http://127.0.0.1.")
    .summary("Follow a run's saved evidence over loopback http.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option(
      "--port <port>",
      "Loopback port to bind on 127.0.0.1. Defaults to an ephemeral port.",
      "0",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Serve without opening a browser.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish observe",
        "  humanish observe --run latest",
        "  humanish observe --run <runId> --port 8732",
        "  humanish observe --no-open --json",
        "",
        "The server binds 127.0.0.1 only and exposes just the run's bundle directory.",
        "It stays attached until Ctrl-C; file:// security policy and live refresh are why",
        "loopback http is preferred over opening the index.html path directly.",
      ].join("\n"),
    )
    .action(
      async (
        options: {
          cwd: string;
          json?: boolean;
          open?: boolean;
          port: string;
          run: string;
        },
        command,
      ) => {
        const port = parseObserverPort(options.port);
        if (port === null) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_INVALID_PORT",
              message: "--port must be an integer between 0 and 65535.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        const rendered = await renderObserver(options.cwd, options.run, { open: false });
        if (!rendered.ok || !rendered.observerPath) {
          writeResult(command, io, rendered, formatObserverHuman);
          io.setExitCode(2);
          return;
        }

        // Reuse the contained current-data projection, scoped to this run. A raw static
        // server would miss runtime status and could replay stored iframe grants.
        const wantsMachine = wantsJson(command);
        const shouldOpen =
          options.open === false
            ? false
            : options.open === true
              ? true
              : !wantsMachine && process.stdout.isTTY === true;

        const server = await serveObserver(rendered, { open: false, port, scope: "run" });
        const openResult: { opened: boolean; command?: string; warning?: string } = shouldOpen
          ? openTarget(server.url)
          : { opened: false };

        const result: ObserverResult = {
          ...rendered,
          observerUrl: server.url,
          serverUrl: server.url,
          opened: openResult.opened,
          ...(openResult.command ? { openCommand: openResult.command } : {}),
          warnings: [
            ...rendered.warnings,
            "Observer is served read-only over loopback http on 127.0.0.1; only this run's bundle directory is exposed.",
            ...(openResult.warning ? [openResult.warning] : []),
          ],
        };

        writeResult(command, io, result, formatObserverHuman);
        io.setExitCode(0);

        await serveObserveUntilSignal(io, server, { json: wantsMachine });
      },
    );
}

async function serveObserveUntilSignal(
  io: CliIo,
  server: { close: () => Promise<void>; url: string },
  options: { json: boolean },
): Promise<void> {
  // Keep the JSON envelope on stdout clean: route attach/stop chatter to stderr
  // for machine output, and to stdout for humans.
  const note = options.json ? io.writeErr : io.writeOut;
  note(`serving: ${server.url}\n`);
  note("serving: press Ctrl-C to stop\n");
  await new Promise<void>((resolveWait) => {
    const signals: WatchStopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<WatchStopSignal, () => void>();
    let stopping = false;

    const stop = (signal: WatchStopSignal) => {
      if (stopping) {
        return;
      }

      stopping = true;
      for (const [registeredSignal, handler] of handlers.entries()) {
        process.removeListener(registeredSignal, handler);
      }
      io.setExitCode(exitCodeForSignal(signal));

      void (async () => {
        try {
          await server.close();
        } catch (error: unknown) {
          io.writeErr(
            `observe cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }

        note("observe stopped\n");
        resolveWait();
      })();
    };

    for (const signal of signals) {
      const handler = () => stop(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

export function registerServeCommand(parent: Command, io: CliIo): void {
  parent
    .command("serve")
    .description(
      "Serve the local run library over loopback http, with optional tunnel-edge authenticated exposure.",
    )
    .summary("Serve the run library; optional tunnel-edge exposure.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option(
      "--port <port>",
      "Loopback port to bind on 127.0.0.1. Defaults to an ephemeral port.",
      "0",
    )
    .option("--run <id>", "Land on this run id (or latest) instead of the library index.")
    .option(
      "--safe",
      "Serve only runs whose verify shareSafety is share_ready; everything else is absent (fail-closed).",
    )
    .option(
      "--expose",
      "Declare exposure intent. Requires edge auth (--oauth or --public-url) OR --safe.",
    )
    .addOption(
      new Option(
        "--tunnel <provider>",
        "Spawn the external tunnel binary against the loopback port.",
      ).choices(["ngrok"]),
    )
    .option(
      "--tunnel-domain <domain>",
      "Reserved domain passed to ngrok as --url (e.g. observer.example.com). Requires --tunnel.",
    )
    .addOption(
      new Option("--oauth <provider>", "Turn on ngrok edge OAuth. Requires --tunnel.").choices([
        "google",
      ]),
    )
    .option(
      "--allow-email <addr>",
      "Edge OAuth allow rule: permit this email. Repeatable. Requires --oauth.",
      collectRepeated,
      [],
    )
    .option(
      "--allow-domain <domain>",
      "Edge OAuth allow rule: permit this domain. Repeatable. Requires --oauth.",
      collectRepeated,
      [],
    )
    .option(
      "--public-url <origin>",
      "Bring-your-own authed edge (e.g. https://observer.example.com). Requires --expose; never affects binding.",
    )
    .option("--open", "Open the library in the default browser.")
    .option("--no-open", "Serve without opening a browser.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Happy path:",
        "  humanish serve",
        "  humanish serve --expose --tunnel ngrok --oauth google --allow-email you@example.com",
        "  humanish serve --safe --expose --tunnel ngrok",
        "  humanish serve --expose --public-url https://observer.example.com",
        "",
        "Agent/CI path:",
        "  humanish serve --json --no-open",
        "",
        "The server always binds 127.0.0.1; exposure only ever happens through an authenticated",
        "edge (ngrok --oauth google, or an operator --public-url you secure) forwarding to the",
        "loopback port. The server carries no in-process auth; the gate lives at the edge. Live",
        "desktop stream URLs are never served here; remote viewers see persisted evidence only.",
        "--safe composes with any exposure for defense in depth.",
      ].join("\n"),
    )
    .action(
      async (
        options: {
          cwd: string;
          expose?: boolean;
          json?: boolean;
          open?: boolean;
          port: string;
          publicUrl?: string;
          run?: string;
          safe?: boolean;
          tunnel?: "ngrok";
          tunnelDomain?: string;
          oauth?: "google";
          allowEmail: string[];
          allowDomain: string[];
        },
        command,
      ) => {
        const wantsMachine = wantsJson(command);
        const fail = (code: ServeErrorCode, message: string): void => {
          const result: ServeResult = {
            schema: SERVE_SCHEMA,
            ok: false,
            cwd: options.cwd,
            mode: "loopback",
            safe: options.safe === true,
            host: "127.0.0.1",
            runsListed: 0,
            warnings: [],
            error: { code, message },
          };
          writeResult(command, io, result, formatServeHuman);
          io.setExitCode(2);
        };

        const port = parseObserverPort(options.port);
        if (port === null) {
          fail("HUMANISH_INVALID_PORT", "--port must be an integer between 0 and 65535.");
          return;
        }

        // Fail-closed exposure matrix (shared validator; tunnel-edge auth only). All guards run before
        // any bind/spawn.
        const exposeValidation = validateExposure("serve", {
          expose: options.expose === true,
          ...(options.tunnel === undefined ? {} : { tunnel: options.tunnel }),
          ...(options.tunnelDomain === undefined ? {} : { tunnelDomain: options.tunnelDomain }),
          ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
          allowEmails: options.allowEmail,
          allowDomains: options.allowDomain,
          ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
          safe: options.safe === true,
        });
        if (!exposeValidation.ok) {
          fail(exposeValidation.error.code, exposeValidation.error.message);
          return;
        }
        const plan = exposeValidation.plan;

        const started = await serveObserverLibrary(options.cwd, {
          port,
          safe: options.safe === true,
          expose: plan.exposed,
          edgeAuthed: plan.edgeAuthed,
          ...(plan.publicOrigin ? { publicOrigin: plan.publicOrigin.origin } : {}),
          ...(options.run ? { entryRunId: options.run } : {}),
        });
        if (!started.ok) {
          fail(started.error.code, started.error.message);
          return;
        }
        const server = started.server;

        let tunnel: ServeTunnel | undefined;
        let publicUrl: string | undefined;
        const warnings: string[] = [];
        if (plan.exposed) {
          try {
            const exposeResult = await startExposedObserver(server, plan);
            tunnel = exposeResult.tunnel;
            publicUrl = exposeResult.publicUrl;
            warnings.push(...exposeResult.warnings);
          } catch (error: unknown) {
            await server.close();
            if (error instanceof ServeTunnelError) {
              fail(error.code, error.message);
            } else {
              fail(
                "HUMANISH_SERVE_TUNNEL_START_FAILED",
                `Tunnel startup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return;
          }
        }

        if (server.mode === "exposed" && options.safe !== true) {
          warnings.push(
            `edge-authed exposure grants read access to all ${server.runsListed} local runs, including any not verified share_ready (local_only raw screenshots, blocked bundles); anyone who clears the edge auth can view them; add --safe to restrict to share_ready`,
          );
        }
        if (server.mode === "exposed" && options.safe === true) {
          warnings.push(
            `edge-authed exposure grants read access to ${server.shareReadyCount ?? 0} share_ready runs; non-share_ready runs are absent even behind the edge`,
          );
        }
        if (server.mode === "share-safe-open") {
          warnings.push(
            `serving ${server.shareReadyCount ?? 0} share_ready runs to anyone who can reach ${publicUrl ?? server.url}; non-share_ready runs are absent and their URLs 404`,
          );
        }
        warnings.push(
          "live desktop stream URLs are never served here; remote viewers see persisted evidence (screenshots, events, terminal tails) only",
        );

        // Auto-open is suppressed under --expose so the public URL is not shoved into a local opener's
        // argv unasked — the exposure target is a remote device anyway. Explicit --open still honors
        // intent and opens the loopback library.
        const shouldOpen =
          options.open === false
            ? false
            : options.open === true
              ? true
              : !wantsMachine && process.stdout.isTTY === true && plan.exposed !== true;
        const openResult: { opened: boolean; command?: string; warning?: string } = shouldOpen
          ? openTarget(server.url)
          : { opened: false };
        if (openResult.warning) {
          warnings.push(openResult.warning);
        }

        const result: ServeResult = {
          schema: SERVE_SCHEMA,
          ok: true,
          cwd: options.cwd,
          mode: server.mode,
          safe: options.safe === true,
          host: "127.0.0.1",
          port: server.port,
          url: server.url,
          ...(publicUrl ? { publicUrl } : {}),
          ...(tunnel ? { tunnel: { provider: "ngrok", url: tunnel.url } } : {}),
          ...(plan.oauth
            ? {
                oauth: {
                  provider: plan.oauth.provider,
                  allowEmails: plan.oauth.allowEmails,
                  allowDomains: plan.oauth.allowDomains,
                },
              }
            : {}),
          runsListed: server.runsListed,
          ...(server.shareReadyCount !== undefined
            ? { shareReadyCount: server.shareReadyCount }
            : {}),
          ...(server.entryRunId ? { entryRunId: server.entryRunId } : {}),
          opened: openResult.opened,
          ...(openResult.command ? { openCommand: openResult.command } : {}),
          warnings,
        };

        writeResult(command, io, result, formatServeHuman);
        io.setExitCode(0);

        await serveObserveUntilSignal(
          io,
          {
            url: server.url,
            close: async () => {
              if (tunnel) {
                await tunnel.close();
              }
              await server.close();
            },
          },
          { json: wantsMachine },
        );
      },
    );
}

function formatServeHuman(result: ServeResult): string {
  if (!result.ok) {
    return (
      [
        "humanish serve failed",
        ...(result.error ? [`error: ${result.error.code} ${result.error.message}`] : []),
        ...result.warnings.map((warning) => `warning: ${warning}`),
      ].join("\n") + "\n"
    );
  }

  const modeSuffix = result.safe ? " (share_ready only)" : "";
  const lines = [
    "humanish serve",
    `mode: ${result.mode}${modeSuffix}`,
    `library: ${result.url ?? ""}`,
    `runs: ${result.runsListed}`,
  ];
  if (result.publicUrl) {
    lines.push(`public: ${result.publicUrl}`);
  }
  if (result.tunnel) {
    lines.push(`tunnel: ${result.tunnel.provider} ${result.tunnel.url}`);
  }
  if (result.oauth) {
    const rules = [...result.oauth.allowEmails, ...result.oauth.allowDomains];
    lines.push(
      `edge auth: ${result.oauth.provider} oauth${rules.length > 0 ? ` (allow: ${rules.join(", ")})` : " (no allow rule — any Google account)"}`,
    );
  }
  if (result.entryRunId) {
    lines.push(`entry: ${result.entryRunId}`);
  }
  lines.push(`opened: ${result.opened === true ? "yes" : "no"}`);
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join("\n") + "\n";
}
