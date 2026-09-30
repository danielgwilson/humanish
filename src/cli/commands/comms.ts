import { resolve } from "node:path";
import { Command } from "commander";
import { COMMS_PROVIDERS, readCommsSetup, saveCommsConnection } from "../../comms/connections.js";
import { checkCommsConnection, configureCommsLab } from "../../comms/setup.js";
import { inspectCommsRecovery, recoverCommsReceiving } from "../../comms/receiving.js";
import { resolveReceivingConnection } from "../../comms/receiving-runtime.js";
import { resolveLabManifest } from "../../lab/discover.js";
import { runCommsCatchHost } from "../../comms/catch-host.js";
import { DEFAULT_SANDBOX_CATCH_PORT } from "../../comms/sandbox-catch.js";
import { applyEnvFileOption, type CliIo, JSON_OPTION_DESCRIPTION, writeResult } from "../io.js";

export function registerCommsCommands(parent: Command, io: CliIo): void {
  const comms = parent
    .command("comms")
    .description("Local email capture, real receiving connections, checks and cleanup recovery.")
    .summary("Off-app comms surfaces.");

  comms
    .command("providers")
    .description("List installed communication provider capabilities. No network requests.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((_options, command) => {
      const result = {
        schema: "humanish.comms-providers.v1",
        ok: true,
        providers: COMMS_PROVIDERS,
      };
      writeResult(command, io, result, () =>
        COMMS_PROVIDERS.map(
          (provider) =>
            `${provider.label}: ${provider.limitation}\nKey: ${provider.keyEnv}\nSetup: ${provider.setupUrl}\n`,
        ).join("\n"),
      );
    });

  const connections = comms
    .command("connections")
    .description(
      "Manage project-local non-secret connection profiles. A lab explicitly selects its receiving connection.",
    );
  connections
    .command("list")
    .description(
      "Show saved connections and local credential status; does not authenticate with a provider.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load credentials for local status without printing values.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; envFile?: string }, command) => {
      if (!(await applyEnvFileOption({ command, cwd: options.cwd, envFile: options.envFile, io })))
        return;
      const result = await readCommsSetup(resolve(options.cwd), process.env);
      writeResult(
        command,
        io,
        result,
        (value) =>
          `${value.message}\nAgentMail key: ${value.credential.present ? "present" : "missing"}\n${value.connections.map((connection) => `${connection.name}: ${connection.provider} (${connection.apiKeyEnv})\n`).join("")}`,
      );
      io.setExitCode(result.ok ? 0 : 2);
    });
  connections
    .command("add")
    .argument("[name]", "Project connection name.", "agentmail")
    .description(
      "Save an AgentMail connection profile. Does not write a key, alter a lab or contact the provider.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--provider <id>", "Installed provider id.", "agentmail")
    .option(
      "--api-key-env <name>",
      "Environment variable NAME, never its value.",
      "AGENTMAIL_API_KEY",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        name: string,
        options: { cwd: string; provider: string; apiKeyEnv: string },
        command,
      ) => {
        const result = {
          schema: "humanish.comms-connection-result.v1",
          ...(options.provider === "agentmail"
            ? await saveCommsConnection(resolve(options.cwd), name, options.apiKeyEnv)
            : { ok: false, message: "Only AgentMail connection setup is currently available." }),
        };
        writeResult(command, io, result, (value) => `${value.message}\n`);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );

  comms
    .command("check")
    .description(
      "Check connection and credential presence; --online authenticates without creating inboxes.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--connection <name>", "Saved connection name.", "agentmail")
    .option("--lab <path>", "Check the connection selected by this exact lab.")
    .option("--online", "Make a read-only provider authentication request.")
    .option("--env-file <path>", "Load credentials without printing values.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          cwd: string;
          connection: string;
          lab?: string;
          online?: boolean;
          envFile?: string;
        },
        command,
      ) => {
        if (
          !(await applyEnvFileOption({ command, cwd: options.cwd, envFile: options.envFile, io }))
        )
          return;
        let connection = options.connection;
        if (options.lab) {
          const lab = await resolveLabManifest(options.cwd, options.lab);
          if (!lab.ok || lab.config.comms?.email?.kind !== "real") {
            const result = {
              ok: false,
              message: "This lab does not select a real email connection.",
            };
            writeResult(command, io, result, (value) => `${value.message}\n`);
            io.setExitCode(2);
            return;
          }
          connection = lab.config.comms.email.connection;
        }
        const result = await checkCommsConnection({
          cwd: resolve(options.cwd),
          connection,
          env: process.env,
          online: options.online === true,
        });
        writeResult(command, io, result, (value) => `${value.message}\n`);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
  comms
    .command("configure")
    .description(
      "Preview or save a local receiving-enabled copy of a supported lab. No provider requests.",
    )
    .requiredOption("--lab <path>", "Exact source lab path or handle.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--connection <name>", "Saved connection name.", "agentmail")
    .option("--apply", "Save the local copy; original lab remains unchanged.")
    .option(
      "--plan-token <digest>",
      "Require the source and destination to match a previous preview.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          cwd: string;
          lab: string;
          connection: string;
          apply?: boolean;
          planToken?: string;
        },
        command,
      ) => {
        const result = await configureCommsLab({ ...options, cwd: resolve(options.cwd) });
        writeResult(command, io, result, (value) => `${value.message}\n`);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
  comms
    .command("recover")
    .description(
      "Inspect interrupted email leases; --apply deletes only privately recorded resources owned by this project and account.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--run <id>", "One run to inspect or recover.")
    .option("--apply", "Recover the selected inactive run and verify mailbox deletion.")
    .option("--env-file <path>", "Load credentials without printing values.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: { cwd: string; run?: string; apply?: boolean; envFile?: string },
        command,
      ) => {
        if (
          !(await applyEnvFileOption({ command, cwd: options.cwd, envFile: options.envFile, io }))
        )
          return;
        const cwd = resolve(options.cwd);
        try {
          const entries = (await inspectCommsRecovery({ cwd })).filter(
            (entry) => !options.run || entry.runId === options.run,
          );
          if (!options.apply) {
            const result = { schema: "humanish.comms-recovery.v1", ok: true, entries };
            writeResult(command, io, result, (value) =>
              value.entries.length
                ? value.entries
                    .map(
                      (entry) =>
                        `${entry.runId}: ${entry.unresolvedCount} unresolved; ${entry.activeOwner === null ? "unknown owner" : entry.activeOwner ? "active owner" : "inactive"}\n`,
                    )
                    .join("")
                : "No recoverable email leases in this project.\n",
            );
            return;
          }
          if (!options.run || entries.length !== 1) throw new Error("selection");
          const entry = entries[0]!;
          const { connection, adapter } = await resolveReceivingConnection(
            cwd,
            entry.connectionName,
            process.env,
          );
          const result = {
            schema: "humanish.comms-recovery-result.v1",
            ...(await recoverCommsReceiving({
              cwd,
              runId: options.run,
              connectionName: entry.connectionName,
              apiKeyEnv: connection.apiKeyEnv,
              adapter,
            })),
          };
          writeResult(command, io, result, (value) => `${value.message}\n`);
          io.setExitCode(result.ok ? 0 : 2);
        } catch {
          const result = {
            schema: "humanish.comms-recovery-result.v1",
            ok: false,
            message:
              "Recovery could not complete. Select one recorded run with --run, check its connection, and retry. No unrecorded resources are eligible.",
          };
          writeResult(command, io, result, (value) => `${value.message}\n`);
          io.setExitCode(2);
        }
      },
    );

  comms
    .command("catch")
    .description(
      "Run the email catch on this host so humanish can study an app it does not provision. Your app posts its email sends here; the persona opens /inbox; humanish drains GET /deliveries and writes digest-only evidence. Point your lab's comms.email.external.catchBaseUrl at this server.",
    )
    .summary("Run the adopter-hosted email catch.")
    .option(
      "--port <port>",
      "Port for capture + inbox (default 8025).",
      String(DEFAULT_SANDBOX_CATCH_PORT),
    )
    .option(
      "--dir <path>",
      "Directory for the deliveries log and rendered inbox.",
      ".humanish/comms-catch",
    )
    .option(
      "--token <value>",
      "Require this bearer token on GET /deliveries (recommended when reachable off-host).",
    )
    .option(
      "--smtp-port <port>",
      "Also capture SMTP mail on 127.0.0.1:<port>. Point your app's SMTP transport here.",
    )
    .option(
      "--inbox-port <port>",
      "Also serve a READ-ONLY inbox listener on 0.0.0.0:<port>, so a persona on another machine can open /inbox. Without it the catch stays loopback-only.",
    )
    .option(
      "--recipient <address>",
      "Only render mail sent to this address (repeatable). Default: render whatever the app actually mailed.",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .action(
      async (options: {
        port: string;
        dir: string;
        token?: string;
        smtpPort?: string;
        inboxPort?: string;
        recipient?: string[];
      }) => {
        const port = Number.parseInt(options.port, 10);
        if (!Number.isInteger(port) || port <= 0 || port > 65_534) {
          io.writeErr("--port must be an integer between 1 and 65534.\n");
          io.setExitCode(2);
          return;
        }
        let inboxPort: number | undefined;
        if (options.inboxPort !== undefined) {
          inboxPort = Number.parseInt(options.inboxPort, 10);
          if (!Number.isInteger(inboxPort) || inboxPort <= 0 || inboxPort > 65_534) {
            io.writeErr("--inbox-port must be an integer between 1 and 65534.\n");
            io.setExitCode(2);
            return;
          }
          if (inboxPort === port) {
            io.writeErr(
              "--inbox-port must differ from --port (the capture listener is loopback-only; the inbox listener is not).\n",
            );
            io.setExitCode(2);
            return;
          }
        }
        let smtpPort: number | undefined;
        if (options.smtpPort !== undefined) {
          smtpPort = Number(options.smtpPort);
          if (!Number.isInteger(smtpPort) || smtpPort <= 0 || smtpPort > 65_534) {
            io.writeErr("--smtp-port must be an integer between 1 and 65534.\n");
            io.setExitCode(2);
            return;
          }
          if (smtpPort === port || smtpPort === inboxPort) {
            io.writeErr("--smtp-port must differ from --port and --inbox-port.\n");
            io.setExitCode(2);
            return;
          }
        }
        await runCommsCatchHost(
          {
            port,
            dir: options.dir,
            ...(options.token ? { token: options.token } : {}),
            ...(inboxPort === undefined ? {} : { inboxPort }),
            ...(smtpPort === undefined ? {} : { smtpPort }),
            ...(options.recipient && options.recipient.length > 0
              ? { recipients: options.recipient }
              : {}),
          },
          io,
        );
      },
    );
}
