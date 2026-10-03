import { Command, Option } from "commander";
import { serveObserver } from "../../observer/render.js";
import type { ObserverResult, ObserverServer } from "../../observer/render.js";
import { WATCH_SAFE_NOT_APPLICABLE_MESSAGE } from "../../observer/exposure.js";
import { runDryRun } from "../../run/dry-run.js";
import type { RunResult } from "../../run/results.js";
import { runStudyCommand } from "./study-run.js";
import { addRunOptions, studyOnlyFlags } from "./run-command.js";
import {
  applyEnvFileOption,
  type CliIo,
  collectRepeated,
  formatRunHuman,
  type StudyCommandOptions,
  parseObserverPort,
  parsePositiveInteger,
  wantsJson,
  writeResult,
} from "../io.js";
import { followObserver, formatObserverHuman, watchExposeRequested } from "../observer-follow.js";

export function registerWatchCommand(parent: Command, io: CliIo): void {
  // A run's flags come from addRunOptions, the helper `run` uses, so the two cannot drift.
  addRunOptions(
    parent
      .command("watch")
      .argument("[study]", "Study id or .yaml path to run and observe.")
      .description("Run a study, open its Observer and keep the shell attached.")
      .summary("Run a study and follow it in the Observer.")
      .option("--study <id-or-path>", "Study id or .yaml path, in place of the argument."),
  )
    .option(
      "--expose",
      "Computer-use studies only: share the live run through an authenticated tunnel, to watch from a phone. Requires --oauth or --public-url.",
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
      "Bring-your-own authed edge (Cloudflare Access/Tailscale/manual). Binds loopback and trusts your edge. Requires --expose.",
    )
    // Hidden: watch rejects --safe with a pointer to the library filter and to edge auth, which
    // a bare "unknown option" would lose.
    .addOption(new Option("--safe").hideHelp())
    .addHelpText(
      "after",
      [
        "",
        "Without a study or --run, watch starts a synthetic run of 4 participants; --count changes it.",
        "",
        "Happy path:",
        "  humanish watch",
        "  humanish watch first-run",
        "",
        "Watch a live computer-use run from your phone through an authenticated tunnel:",
        "  humanish watch my-browser-study --expose --tunnel ngrok --oauth google --allow-email you@example.com",
        "",
        "Agent/CI path:",
        "  humanish watch --json --no-open",
        "",
        "Saved runs:",
        "  humanish observe --run latest",
      ].join("\n"),
    )
    .action((named, options, command) => handleWatch(io, named, options, command));
}

interface WatchOptions extends StudyCommandOptions {
  port: string;
  study?: string;
  expose?: boolean;
  tunnel?: "ngrok";
  tunnelDomain?: string;
  oauth?: "google";
  allowEmail?: string[];
  allowDomain?: string[];
  publicUrl?: string;
  safe?: boolean;
}

type WatchRefusal = { code: NonNullable<RunResult["error"]>["code"]; message: string };

async function handleWatch(
  io: CliIo,
  named: string | undefined,
  parsed: WatchOptions,
  command: Command,
): Promise<void> {
  const options = parsed;
  const option = options.study;
  const study = option ?? named;
  if (option !== undefined && named !== undefined) {
    refuseWatch(command, io, options.cwd, {
      code: "HUMANISH_WATCH_OPTION_CONFLICT",
      message: "Use either a study argument or --study, not both.",
    });
    return;
  }

  if (
    !(await applyEnvFileOption({
      command,
      cwd: options.cwd,
      envFile: options.envFile,
      io,
      // runStudyCommand discovers keys for a live study; a preview run needs none.
      discoverKeys: false,
    }))
  ) {
    return;
  }

  if (study) {
    await watchStudy(io, command, study, options);
    return;
  }

  const studyOnly = studyOnlyFlags(options);
  if (studyOnly.length > 0) {
    refuseWatch(command, io, options.cwd, {
      code: "HUMANISH_WATCH_OPTION_CONFLICT",
      message: `${studyOnly.join(", ")} ${studyOnly.length === 1 ? "needs" : "need"} a study: humanish watch <study>.`,
    });
    return;
  }

  // Exposure is only meaningful for a live computer-use study run (it serves the live desktop). A
  // watch without a study starts a fresh synthetic run with no live desktop to stream, so exposure
  // flags there are refused rather than silently ignored; use `observe --all`.
  if (watchExposeRequested(options)) {
    refuseWatch(command, io, options.cwd, {
      code: "HUMANISH_WATCH_OPTION_CONFLICT",
      message:
        "--expose/--tunnel/--oauth apply only to a live computer-use run; to expose finished evidence use `humanish observe --all --expose`.",
    });
    return;
  }
  // --safe is an `observe --all` library filter; watch shows one run and has nothing to filter.
  if (options.safe === true) {
    refuseWatch(command, io, options.cwd, {
      code: "HUMANISH_WATCH_SAFE_NOT_APPLICABLE",
      message: WATCH_SAFE_NOT_APPLICABLE_MESSAGE,
    });
    return;
  }

  const target = resolveWatchTarget(options);
  if ("code" in target) {
    refuseWatch(command, io, options.cwd, target);
    return;
  }

  const wantsMachine = wantsJson(command);
  const shouldOpen =
    options.open === false
      ? false
      : options.open === true
        ? true
        : !wantsMachine && process.stdout.isTTY === true;
  const wantsFollow = !wantsMachine && options.detach !== true;
  const staticOpen = wantsFollow ? false : shouldOpen;

  const rendered = await renderWatchEvidence(
    io,
    command,
    options,
    target.requestedParticipantCount,
    staticOpen,
  );
  if (rendered === undefined) return;
  await reportWatch(io, command, rendered, {
    follow: wantsFollow,
    open: shouldOpen,
    port: target.port,
  });
}

function refuseWatch(command: Command, io: CliIo, cwd: string, refusal: WatchRefusal): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd,
    warnings: [],
    error: refusal,
  };
  writeResult(command, io, result, formatRunHuman);
  io.setExitCode(2);
}

/** A study argument starts that study under watch. */
async function watchStudy(
  io: CliIo,
  command: Command,
  study: string,
  options: WatchOptions,
): Promise<void> {
  // Forwarded wholesale, as `run` forwards its options, so a run flag reaches the run either way.
  await runStudyCommand({ command, io, study, mode: "watch", options });
}

/** Without a study, watch starts a fresh synthetic run of `--count` participants, 4 by default. */
function resolveWatchTarget(
  options: WatchOptions,
): WatchRefusal | { requestedParticipantCount: number; port: number } {
  const participantCount =
    options.count === undefined ? undefined : parsePositiveInteger(options.count);
  const port = parseObserverPort(options.port);
  if (participantCount === null) {
    return {
      code: "HUMANISH_INVALID_PARTICIPANT_COUNT",
      message: "--count must be a positive integer.",
    };
  }
  if (port === null) {
    return {
      code: "HUMANISH_INVALID_PORT",
      message: "--port must be an integer between 0 and 65535.",
    };
  }
  return { requestedParticipantCount: participantCount ?? 4, port };
}

/** Render the fresh run; undefined when it failed and its result was written. */
async function renderWatchEvidence(
  io: CliIo,
  command: Command,
  options: WatchOptions,
  requestedParticipantCount: number,
  staticOpen: boolean,
): Promise<ObserverResult | undefined> {
  // A fresh run renders through its finished run, so the page shown is the run just written,
  // never a directory swapped in under its id.
  const runResult = await runDryRun({
    cwd: options.cwd,
    dryRun: true,
    participantCount: requestedParticipantCount,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    observer: { open: staticOpen },
  });
  if (!runResult.ok || runResult.observer === undefined) {
    writeResult(command, io, runResult, formatRunHuman);
    io.setExitCode(2);
    return undefined;
  }
  return runResult.observer;
}

/** Write the result, then keep a live server attached when following. */
async function reportWatch(
  io: CliIo,
  command: Command,
  rendered: ObserverResult,
  serve: { follow: boolean; open: boolean; port: number },
): Promise<void> {
  let server: ObserverServer | null = null;
  let result = rendered;
  if (rendered.ok && serve.follow) {
    server = await serveObserver(rendered, { open: serve.open, port: serve.port });
    result = {
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
  writeResult(command, io, result, formatObserverHuman);
  io.setExitCode(result.ok ? 0 : 2);

  if (result.ok && server) {
    await followObserver(io, result, server);
  }
}
