import { Command, Option } from "commander";
import { renderObserver, serveObserver } from "../../observer/render.js";
import type { ObserverServer } from "../../observer/render.js";
import { runDryRun } from "../../run/dry-run.js";
import type { RunResult } from "../../run/results.js";
import { runLabCommand } from "./lab-run.js";
import {
  applyEnvFileOption,
  type CliIo,
  collectRepeated,
  formatRunHuman,
  JSON_OPTION_DESCRIPTION,
  parseObserverPort,
  parsePositiveInteger,
  wantsJson,
  writeResult,
} from "../io.js";
import { followObserver, formatObserverHuman, watchExposeRequested } from "../observer-follow.js";

export function registerWatchCommand(parent: Command, io: CliIo): void {
  parent
    .command("watch")
    .argument("[lab]", "Optional lab id or .yaml path to run and observe.")
    .description("Run sims, open the observer, and keep the shell attached.")
    .summary("Run sims, open the observer, keep the shell attached.")
    .option("--lab <id-or-path>", "Explicit lab id or .yaml path.")
    .option("--run <id>", "Watch an existing run id or latest pointer.")
    .option("--dry-run", "Lab only: render contract evidence without live provider spend.")
    .option(
      "--sims <count>",
      "Start a fresh synthetic run with this many sims before rendering. Defaults to 4 when --run is omitted.",
    )
    .option("--count <count>", "Lab only: override headed desktop lane count.")
    .option(
      "--scorer <path>",
      "Terminal/computer-use/shared-world labs only: repo-relative adopter scorer module (.mjs). Overrides review.scorer.ref. Executable code: review it as code.",
    )
    .option(
      "--run-id <id>",
      "Explicit run id for deterministic fixture tests; refused when that run already exists.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load a local env file for this watch without persisting values.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .addOption(new Option("--follow", "Deprecated; human output follows by default.").hideHelp())
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option(
      "--expose",
      "CUA lab only: expose the live run through an authenticated edge so you can watch from a phone. Requires edge auth.",
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
      "Bring-your-own authed edge (Cloudflare Access/Tailscale/manual). Binds loopback and trusts your edge. Requires --expose.",
    )
    .option(
      "--safe",
      "Not applicable to watch: a live run is never share_ready, so --safe (a `serve` library filter) is rejected here. Restrict viewers with edge auth (--allow-email/--allow-domain).",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Happy path:",
        "  humanish watch",
        "  humanish watch first-run",
        "  humanish watch --lab .humanish/labs/local.yaml",
        "",
        "Watch a live CUA run from your phone (tunnel-edge auth):",
        "  humanish watch my-cua-lab --expose --tunnel ngrok --oauth google --allow-email you@example.com",
        "",
        "Agent/CI path:",
        "  humanish watch --json --no-open",
        "",
        "Existing evidence:",
        "  humanish watch --run latest --detach",
      ].join("\n"),
    )
    .action(
      async (
        labArg: string | undefined,
        options: {
          cwd: string;
          count?: string;
          detach?: boolean;
          dryRun?: boolean;
          envFile?: string;
          follow?: boolean;
          json?: boolean;
          lab?: string;
          open?: boolean;
          port: string;
          run?: string;
          runId?: string;
          scorer?: string;
          sims?: string;
          expose?: boolean;
          tunnel?: "ngrok";
          tunnelDomain?: string;
          oauth?: "google";
          allowEmail: string[];
          allowDomain: string[];
          publicUrl?: string;
          safe?: boolean;
        },
        command,
      ) => {
        const lab = options.lab ?? labArg;
        if (options.lab !== undefined && labArg !== undefined) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_WATCH_OPTION_CONFLICT",
              message: "Use either positional lab or --lab, not both.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        if (
          !(await applyEnvFileOption({
            command,
            cwd: options.cwd,
            envFile: options.envFile,
            io,
          }))
        ) {
          return;
        }

        if (lab) {
          if (options.run !== undefined) {
            const result: RunResult = {
              schema: "humanish.run-result.v1",
              ok: false,
              cwd: options.cwd,
              warnings: [],
              error: {
                code: "HUMANISH_WATCH_OPTION_CONFLICT",
                message:
                  "Use either a lab to start evidence or --run to watch existing evidence, not both.",
              },
            };
            writeResult(command, io, result, formatRunHuman);
            io.setExitCode(2);
            return;
          }

          await runLabCommand({
            command,
            io,
            lab,
            mode: "watch",
            options: {
              cwd: options.cwd,
              ...(options.count === undefined ? {} : { count: options.count }),
              ...(options.detach === undefined ? {} : { detach: options.detach }),
              ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
              ...(options.open === undefined ? {} : { open: options.open }),
              port: options.port,
              ...(options.runId === undefined ? {} : { runId: options.runId }),
              ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
              ...(options.sims === undefined ? {} : { sims: options.sims }),
              ...(options.expose === undefined ? {} : { expose: options.expose }),
              ...(options.tunnel === undefined ? {} : { tunnel: options.tunnel }),
              ...(options.tunnelDomain === undefined ? {} : { tunnelDomain: options.tunnelDomain }),
              ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
              allowEmail: options.allowEmail,
              allowDomain: options.allowDomain,
              ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
              ...(options.safe === undefined ? {} : { safe: options.safe }),
              ...(options.json === undefined ? {} : { json: options.json }),
            },
          });
          return;
        }

        // Exposure is only meaningful for a live CUA lab run (it serves the live desktop). The
        // non-lab watch path (existing evidence, or a fresh synthetic run) has no live desktop to
        // stream, so exposure flags there are refused rather than silently ignored — use `serve`.
        if (watchExposeRequested(options)) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_WATCH_OPTION_CONFLICT",
              message:
                "--expose/--tunnel/--oauth apply only to a live CUA lab run; to expose finished evidence use `humanish serve --expose`.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        const runOptionSource =
          typeof command.getOptionValueSource === "function"
            ? command.getOptionValueSource("run")
            : undefined;
        const runWasOmitted = runOptionSource === undefined || runOptionSource === "default";
        const simCount =
          options.sims === undefined ? undefined : parsePositiveInteger(options.sims);
        const port = parseObserverPort(options.port);
        if (options.sims !== undefined && simCount === null) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_INVALID_SIM_COUNT",
              message: "--sims must be a positive integer.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }
        if (!runWasOmitted && options.sims !== undefined) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_WATCH_OPTION_CONFLICT",
              message:
                "Use either --run to watch existing evidence or --sims to start a fresh run, not both.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }
        if (!runWasOmitted && options.runId !== undefined) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_WATCH_OPTION_CONFLICT",
              message:
                "--run-id only applies to fresh watch runs; remove --run or remove --run-id.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }
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
        const requestedSimCount = simCount ?? (runWasOmitted ? 4 : undefined);

        let runInput = options.run ?? "latest";
        if (requestedSimCount !== undefined && requestedSimCount !== null) {
          const runResult = await runDryRun({
            cwd: options.cwd,
            dryRun: true,
            simCount: requestedSimCount,
            ...(options.runId === undefined ? {} : { runId: options.runId }),
          });

          if (!runResult.ok || !runResult.runId) {
            writeResult(command, io, runResult, formatRunHuman);
            io.setExitCode(2);
            return;
          }

          runInput = runResult.runId;
        }

        const wantsMachine = wantsJson(command);
        const shouldOpen =
          options.open === false
            ? false
            : options.open === true
              ? true
              : !wantsMachine && process.stdout.isTTY === true;
        const wantsFollow = !wantsMachine && options.detach !== true && options.follow !== false;
        const rendered = await renderObserver(options.cwd, runInput, {
          open: wantsFollow ? false : shouldOpen,
        });
        let server: ObserverServer | null = null;
        let result = rendered;
        if (rendered.ok && wantsFollow) {
          server = await serveObserver(rendered, { open: shouldOpen, port });
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
      },
    );
}
