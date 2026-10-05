import { Command, Option } from "commander";
import { openTarget, renderObserver, serveObserver } from "../../observer/render.js";
import type { ObserverResult } from "../../observer/render.js";
import { type HiddenRunGroup, SERVE_SCHEMA, serveObserverLibrary } from "../../observer/serve.js";
import type { ServeErrorCode, ServeLibraryServer, ServeResult } from "../../observer/serve.js";
import { startExposedObserver, validateExposure } from "../../observer/exposure.js";
import type { ExposurePlan, ExposureResult } from "../../observer/exposure.js";
import { ServeTunnelError } from "../../observer/tunnel.js";
import type { RunResult } from "../../run/results.js";
import {
  type CliIo,
  collectRepeated,
  CWD_OPTION_DESCRIPTION,
  formatRunHuman,
  freePortOption,
  JSON_OPTION_DESCRIPTION,
  parseObserverPort,
  RUN_OPTION_DESCRIPTION,
  wantsJson,
  writeResult,
  type HumanOutput,
} from "../io.js";
import {
  exitCodeForSignal,
  formatObserverHuman,
  personAtTerminal,
  unattendedObserverWarning,
  type WatchStopSignal,
} from "../observer-follow.js";

export function registerObserveCommand(parent: Command, io: CliIo): void {
  addLibraryOptions(
    parent
      .command("observe")
      .description(
        "Open a saved run in the Observer, served on http://127.0.0.1; without --run, the latest. With --all, serve the run library, opening on --run when given.",
      )
      .summary("Open a saved run in the Observer.")
      .option("--run <id>", RUN_OPTION_DESCRIPTION)
      .option("--all", "Serve the whole run library, with optional tunnel-edge exposure.")
      .addOption(freePortOption())
      .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
      .option("--open", "Open the Observer in the default browser.")
      .option("--no-open", "Serve without opening a browser.")
      .option(
        "--serve",
        "Serve one run until Ctrl-C even without an interactive terminal; by default an agent's shell or a pipe gets the Observer path and an exit.",
      )
      .option("--json", JSON_OPTION_DESCRIPTION),
  )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish observe",
        "  humanish observe --run latest",
        "  humanish observe --run <runId> --port 8732",
        "  humanish observe --no-open --json",
        "  humanish observe --all",
        "  humanish observe --all --expose --tunnel ngrok --oauth google --allow-email you@example.com",
        "  humanish observe --all --safe --expose --tunnel ngrok",
        "  humanish observe --all --expose --public-url https://observer.example.com",
        "",
        "The server binds 127.0.0.1 only. One run exposes just that run's bundle directory; --all",
        "serves the run library. It stays attached until Ctrl-C; file:// security policy and live",
        "refresh are why loopback http is preferred over opening the index.html path directly.",
        "Without an interactive terminal, as in an agent's shell or a pipe, observe for one run",
        "prints the Observer path and exits; --serve keeps it serving.",
        "",
        "--safe, --expose, --tunnel, --tunnel-domain, --oauth, --allow-email, --allow-domain and",
        "--public-url need --all. Exposure only ever happens through an authenticated edge (ngrok",
        "--oauth google, or an operator --public-url you secure) forwarding to the loopback port;",
        "the server carries no in-process auth. Live desktop stream URLs are never served; remote",
        "viewers see persisted evidence only. --safe composes with any exposure.",
      ].join("\n"),
    )
    .action((options: ObserveOptions, command: Command) => handleObserve(io, options, command));
}

/** The run library's flags, on `observe --all` and the hidden `serve` alias. */
function addLibraryOptions(command: Command): Command {
  return command
    .option(
      "--safe",
      "Serve only runs whose verify shareSafety is share_ready; other runs are not served at all.",
    )
    .option(
      "--expose",
      "Share the library beyond this machine. Requires --oauth or --public-url, or --safe.",
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
    )
    .option(
      "--allow-domain <domain>",
      "Edge OAuth allow rule: permit this domain. Repeatable. Requires --oauth.",
      collectRepeated,
    )
    .option(
      "--public-url <origin>",
      "Bring-your-own authed edge (e.g. https://observer.example.com). Requires --expose; never affects binding.",
    );
}

interface ObserveOptions extends Omit<ServeOptions, "run"> {
  all?: boolean;
  run?: string;
  serve?: boolean;
}

/** The library flags set on a one-run observe, as typed on the command line. */
function libraryOnlyFlags(options: ObserveOptions): string[] {
  return [
    options.safe === true ? ["--safe"] : [],
    options.expose === true ? ["--expose"] : [],
    options.tunnel === undefined ? [] : ["--tunnel"],
    options.tunnelDomain === undefined ? [] : ["--tunnel-domain"],
    options.oauth === undefined ? [] : ["--oauth"],
    (options.allowEmail?.length ?? 0) === 0 ? [] : ["--allow-email"],
    (options.allowDomain?.length ?? 0) === 0 ? [] : ["--allow-domain"],
    options.publicUrl === undefined ? [] : ["--public-url"],
  ].flat();
}

function refuseObserve(command: Command, io: CliIo, cwd: string, error: RunResult["error"]): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd,
    warnings: [],
    ...(error === undefined ? {} : { error }),
  };
  writeResult(command, io, result, formatRunHuman);
  io.setExitCode(2);
}

/** `observe` shows one run (default latest); `observe --all` serves the run library. */
async function handleObserve(io: CliIo, options: ObserveOptions, command: Command): Promise<void> {
  if (options.all === true) {
    await handleServe(io, options, command);
    return;
  }
  const libraryOnly = libraryOnlyFlags(options);
  if (libraryOnly.length > 0) {
    refuseObserve(command, io, options.cwd, {
      code: "HUMANISH_OBSERVE_OPTION_CONFLICT",
      message: `${libraryOnly.join(", ")} ${libraryOnly.length === 1 ? "needs" : "need"} --all: humanish observe --all ${libraryOnly.join(" ")}.`,
    });
    return;
  }
  await observeRun(io, { ...options, run: options.run ?? "latest" }, command);
}

/** One run's Observer over loopback, until a signal stops it. */
async function observeRun(
  io: CliIo,
  options: { cwd: string; open?: boolean; port: string; run: string; serve?: boolean },
  command: Command,
): Promise<void> {
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

  const wantsMachine = wantsJson(command);
  if (options.serve !== true && !personAtTerminal()) {
    // Nobody can press Ctrl-C here, so a server would wait forever: print the path and exit.
    const result: ObserverResult = {
      ...rendered,
      warnings: [...rendered.warnings, unattendedObserverWarning("observe")],
    };
    writeResult(command, io, result, formatObserverHuman);
    io.setExitCode(0);
    return;
  }

  // Reuse the contained current-data projection, scoped to this run. A raw static
  // server would miss runtime status and could replay stored iframe grants.
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
}

async function serveObserveUntilSignal(
  io: CliIo,
  server: { close: () => Promise<void>; url: string },
  options: { json: boolean },
): Promise<void> {
  // Keep the JSON envelope on stdout clean: route attach/stop chatter to stderr
  // for machine output, and to stdout for humans.
  const note = options.json ? io.writeErr : io.writeOut;
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
    // The prompt follows the handlers, as in followObserver.
    note(`serving: ${server.url}\n`);
    note("serving: press Ctrl-C to stop\n");
  });
}

interface ServeOptions {
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
  allowEmail?: string[];
  allowDomain?: string[];
}

type ServeFail = (code: ServeErrorCode, message: string) => void;

async function handleServe(io: CliIo, options: ServeOptions, command: Command): Promise<void> {
  const fail: ServeFail = (code, message) => refuseServe(command, io, options, code, message);

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
    allowEmails: options.allowEmail ?? [],
    allowDomains: options.allowDomain ?? [],
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
  const edge = await startServeEdge(started.server, plan, fail);
  if (edge === undefined) return;
  await reportServe(io, command, options, started.server, plan, edge);
}

function refuseServe(
  command: Command,
  io: CliIo,
  options: ServeOptions,
  code: ServeErrorCode,
  message: string,
): void {
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
}

/**
 * Puts the planned edge in front of the loopback server. Resolves to undefined after closing the
 * server and reporting the failure when the edge does not start.
 */
async function startServeEdge(
  server: ServeLibraryServer,
  plan: ExposurePlan,
  fail: ServeFail,
): Promise<ExposureResult | undefined> {
  if (!plan.exposed) return { warnings: [] };
  try {
    return await startExposedObserver(server, plan);
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
    return undefined;
  }
}

function serveExposureWarnings(
  server: ServeLibraryServer,
  safe: boolean,
  publicUrl: string | undefined,
): string[] {
  const warnings: string[] = [];
  if (server.mode === "exposed" && !safe) {
    warnings.push(
      `edge-authed exposure grants read access to all ${server.runsListed} local runs, including any not verified share_ready (local_only raw screenshots, blocked bundles); anyone who clears the edge auth can view them; add --safe to restrict to share_ready`,
    );
  }
  if (server.mode === "exposed" && safe) {
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
  return warnings;
}

/** Opens the library when asked, writes the result, and serves until a signal closes the edge. */
async function reportServe(
  io: CliIo,
  command: Command,
  options: ServeOptions,
  server: ServeLibraryServer,
  plan: ExposurePlan,
  edge: ExposureResult,
): Promise<void> {
  const wantsMachine = wantsJson(command);
  const { tunnel, publicUrl } = edge;
  const warnings = [
    ...edge.warnings,
    ...serveExposureWarnings(server, options.safe === true, publicUrl),
  ];

  // Auto-open is suppressed under --expose so the public URL is not shoved into a local opener's
  // argv unasked; the exposure target is a remote device anyway. Explicit --open still honors
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
    ...(server.shareReadyCount !== undefined ? { shareReadyCount: server.shareReadyCount } : {}),
    ...(server.hiddenRuns !== undefined ? { hiddenRuns: server.hiddenRuns } : {}),
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
}

/**
 * The runs --safe left out, grouped by grade and reasons, and how to share one. A run held back
 * only for raw screenshots can be exported as a copy with blurred screenshots; the read-results
 * docs name that step.
 */
function hiddenRunLines(groups: readonly HiddenRunGroup[]): string[] {
  const total = groups.reduce((sum, group) => sum + group.runs, 0);
  if (total === 0) return [];
  const runs = (count: number): string => `${count} run${count === 1 ? "" : "s"}`;
  const lines = [`hidden: ${runs(total)} not share_ready`];
  for (const group of groups) {
    const reasons = group.reasons.length > 0 ? ` (${group.reasons.join(", ")})` : "";
    lines.push(`  ${runs(group.runs)} ${group.status}${reasons}`);
  }
  // Export clears both: it blurs screenshots and writes no raw sandbox id.
  const exportable = new Set(["RAW_SCREENSHOTS", "RAW_SANDBOX_ID"]);
  if (
    groups.some(
      (group) =>
        group.reasons.length > 0 && group.reasons.every((reason) => exportable.has(reason)),
    )
  )
    lines.push(
      "share: a run held back only for RAW_SCREENSHOTS or RAW_SANDBOX_ID can be copied with blurred screenshots and no sandbox ids: `humanish export --run <id> --format bundle --redact-screenshots --out <dir>`, then `humanish observe --all --safe --cwd <dir>`",
    );
  lines.push("why: `humanish verify --run <id>` explains each reason");
  return lines;
}

function formatServeHuman(result: ServeResult): HumanOutput {
  if (!result.ok) {
    const warnings = result.warnings.map((warning) => `warning: ${warning}\n`).join("");
    return { ...(warnings ? { stdout: warnings } : {}), error: result.error };
  }

  const modeSuffix = result.safe ? " (share_ready only)" : "";
  const lines = [
    "humanish observe --all",
    `mode: ${result.mode}${modeSuffix}`,
    `library: ${result.url ?? ""}`,
    `runs: ${result.runsListed}`,
    ...hiddenRunLines(result.hiddenRuns ?? []),
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
      `edge auth: ${result.oauth.provider} oauth${rules.length > 0 ? ` (allow: ${rules.join(", ")})` : " (no allow rule: any Google account can sign in)"}`,
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
