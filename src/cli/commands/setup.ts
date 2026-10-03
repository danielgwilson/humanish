import { Command } from "commander";
import {
  listUserKeys,
  resolveKeyName,
  setUserKey,
  unsetUserKey,
  userKeyStorePath,
} from "../../keys/key-resolution.js";
import { promptSecret } from "../secret-prompt.js";
import { runInit } from "../../lab/init.js";
import {
  buildPayload,
  disabledByEnvironment,
  readTelemetryState,
  telemetryStatePath,
  writeTelemetryState,
} from "../telemetry.js";
import type { InitChange, InitResult } from "../../lab/init.js";
import { doctor } from "../doctor.js";
import type { DoctorResult } from "../doctor.js";
import {
  applyEnvFileOption,
  CLI_VERSION,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  ENV_FILE_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  markInvocationEnvelopeWritten,
  wantsJson,
  writeResult,
} from "../io.js";

export function registerInitCommand(parent: Command, io: CliIo): void {
  parent
    .command("init")
    .description("Set up committed humanish/ source files and ignored .humanish/ runtime state.")
    .summary("Set up starter studies and personas in this project.")
    .option("--dry-run", "Print planned changes without writing files.")
    .option("--yes", "Apply safe generated changes without prompting.")
    .option(
      "--local-browser <url>",
      "Set the local-browser starter to this loopback app URL (explicit port above 1023).",
    )
    .option("--local-mission <text>", "Set the local-browser participant mission.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          cwd: string;
          dryRun?: boolean;
          json?: boolean;
          yes?: boolean;
          localBrowser?: string;
          localMission?: string;
        },
        command,
      ) => {
        const initOptions = {
          cwd: options.cwd,
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.localBrowser === undefined && options.localMission === undefined
            ? {}
            : {
                localBrowser: {
                  appUrl: options.localBrowser ?? "http://127.0.0.1:3000",
                  ...(options.localMission === undefined ? {} : { mission: options.localMission }),
                },
              }),
        };
        const result = await runInit(initOptions);

        if (wantsJson(command)) {
          io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok) {
          io.writeOut(formatInitHuman(result));
        } else {
          io.writeErr(formatInitHuman(result));
        }

        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

export function registerDoctorCommand(parent: Command, io: CliIo): void {
  parent
    .command("doctor")
    .description("Explain project readiness and missing humanish setup.")
    .summary("Check what this project and machine need before a run.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option(
      "--lab <lab>",
      "Check the selected lab's desktop, participant authentication and separate analysis requirements; no provider calls.",
    )
    .option("--env-file <path>", ENV_FILE_OPTION_DESCRIPTION)
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (options: { cwd: string; lab?: string; envFile?: string; json?: boolean }, command) => {
        if (
          options.envFile &&
          !(await applyEnvFileOption({ command, cwd: options.cwd, envFile: options.envFile, io }))
        )
          return;
        const result = await doctor(options.cwd, options.lab ? { lab: options.lab } : {});
        writeResult(command, io, result, formatDoctorHuman);
        // Behavioral change: was exit 1, every other structured command uses 2.
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

/**
 * `humanish telemetry status|enable|disable`: the opt-out the convention requires, plus a `status`
 * that prints the exact document that would be sent. "You can read what we collect" is what makes
 * default-on collection checkable by the person it describes.
 */
export function registerTelemetryCommand(parent: Command, io: CliIo): void {
  const telemetry = parent
    .command("telemetry")
    .description("Show or change anonymous usage collection.");

  telemetry
    .command("status", { isDefault: true })
    .description("What is collected, and whether it is on.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { json?: boolean }, command) => {
      const state = await readTelemetryState();
      const envOff = disabledByEnvironment(process.env);
      const sample = buildPayload({
        event: "cli_command",
        anonymousId: state.anonymousId,
        version: CLI_VERSION,
        properties: {
          command: "lab run",
          lab: "try-live",
          mode: "live",
          outcome: "incomplete",
          brain: "provider-key",
          durationBucket: "1-5m",
          ok: false,
          diagnosticCategory: "session_interrupted",
          stopCause: "spend_limit",
        },
      });
      const result = {
        schema: "humanish.telemetry-status.v1" as const,
        ok: true as const,
        enabled: state.enabled && !envOff,
        disabledBy: envOff ? "environment" : state.enabled ? undefined : "config",
        statePath: telemetryStatePath(),
        example: sample,
      };
      if (options.json === true || wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.writeOut(
          [
            `telemetry: ${result.enabled ? "on" : "off"}${envOff ? " (DO_NOT_TRACK / HUMANISH_TELEMETRY_DISABLED)" : ""}`,
            `state: ${result.statePath}`,
            "",
            "a complete example of what is sent — there are no other fields:",
            JSON.stringify(sample, null, 2),
            "",
            "never sent: labs you wrote, subjects, personas, missions, paths, run evidence, key names or values.",
            "",
            "humanish telemetry disable   turns it off",
          ].join("\n") + "\n",
        );
      }
      markInvocationEnvelopeWritten(command);
    });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    telemetry
      .command(name)
      .description(`Turn anonymous usage collection ${name === "enable" ? "on" : "off"}.`)
      .action(async (_options: unknown, command: Command) => {
        const state = await readTelemetryState();
        // Writing `noticed` here too: someone who has just made an explicit choice does not need
        // to be told about the choice next time.
        await writeTelemetryState({ ...state, enabled, noticed: true });
        io.writeOut(`telemetry ${enabled ? "enabled" : "disabled"}\n`);
        markInvocationEnvelopeWritten(command);
      });
  }
}

const KEYS_RESULT_SCHEMA = "humanish.keys-result.v1";

interface KeysResult {
  schema: typeof KEYS_RESULT_SCHEMA;
  ok: boolean;
  action: "set" | "unset" | "list";
  /** The user store path (with values never included anywhere in this envelope). */
  store: string;
  /** `list`: the names present in the store. `set`/`unset`: the affected name. */
  names: string[];
  message: string;
}

function formatKeysHuman(result: KeysResult): string {
  const lines = [
    `humanish keys ${result.ok ? "ok" : "failed"}`,
    `store: ${result.store}`,
    result.message,
  ];
  if (result.action === "list" && result.names.length > 0) {
    for (const name of result.names) lines.push(`- ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Read one secret line: from a piped stdin when --stdin, else a hidden TTY prompt. */
async function readSecretValue(useStdin: boolean, promptLabel: string): Promise<string | null> {
  if (useStdin || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text.length > 0 ? text : null;
  }
  return promptSecret(promptLabel, process.stdin, process.stderr);
}

export function registerKeysCommand(parent: Command, io: CliIo): void {
  const keys = parent
    .command("keys")
    .description("Manage the humanish user-level key store used by provider-key discovery.")
    .summary("Store and manage your provider keys.");

  keys
    .command("set")
    .argument(
      "<vendor-or-name>",
      "A vendor alias (openai, e2b, anthropic, github, agentmail) or a raw ENV_NAME.",
    )
    .description("Store one provider key in the user store (0600), prompted with hidden input.")
    .option("--stdin", "Read the value from stdin instead of prompting (for agents/pipes).")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (vendorOrName: string, options: { stdin?: boolean; json?: boolean }, command) => {
      const name = resolveKeyName(vendorOrName);
      const storePath = userKeyStorePath(process.env);
      if (name === null) {
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA,
          ok: false,
          action: "set",
          store: storePath,
          names: [],
          message: `Not a vendor alias or valid env name: ${vendorOrName}. Vendors: openai, e2b, anthropic, github, agentmail.`,
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(2);
        return;
      }
      const value = await readSecretValue(options.stdin === true, `Value for ${name}`);
      if (value === null) {
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA,
          ok: false,
          action: "set",
          store: storePath,
          names: [name],
          message: "No value provided; nothing written.",
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(2);
        return;
      }
      try {
        const written = setUserKey(name, value, process.env);
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA,
          ok: true,
          action: "set",
          store: written.path,
          names: [name],
          message: `${name} stored (0600). Live commands resolve it automatically; remove with "humanish keys unset ${name}".`,
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(0);
      } catch (error) {
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA,
          ok: false,
          action: "set",
          store: storePath,
          names: [name],
          message: error instanceof Error ? error.message : "Failed to write the key store.",
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(2);
      }
    });

  keys
    .command("unset")
    .argument("<vendor-or-name>", "A vendor alias or raw ENV_NAME to remove from the store.")
    .description("Remove one key from the user store.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (vendorOrName: string, _options: { json?: boolean }, command) => {
      const name = resolveKeyName(vendorOrName);
      const storePath = userKeyStorePath(process.env);
      const had = name !== null && unsetUserKey(name, process.env);
      const result: KeysResult = {
        schema: KEYS_RESULT_SCHEMA,
        ok: name !== null,
        action: "unset",
        store: storePath,
        names: name === null ? [] : [name],
        message:
          name === null
            ? `Not a vendor alias or valid env name: ${vendorOrName}.`
            : had
              ? `${name} removed from the store.`
              : `${name} was not in the store; nothing changed.`,
      };
      writeResult(command, io, result, formatKeysHuman);
      io.setExitCode(name === null ? 2 : 0);
    });

  keys
    .command("list")
    .description("List the NAMES stored in the user store. Values are never printed.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (_options: { json?: boolean }, command) => {
      const storePath = userKeyStorePath(process.env);
      const names = listUserKeys(process.env);
      const result: KeysResult = {
        schema: KEYS_RESULT_SCHEMA,
        ok: true,
        action: "list",
        store: storePath,
        names,
        message:
          names.length === 0
            ? "The store is empty. Add a key with `humanish keys set <vendor>`."
            : `${names.length} key name(s) stored. Values are never printed.`,
      };
      writeResult(command, io, result, formatKeysHuman);
      io.setExitCode(0);
    });
}

function formatDoctorHuman(result: DoctorResult): string {
  return (
    [
      `humanish doctor ${result.ok ? "ok" : "needs setup"}`,
      `cwd: ${result.cwd}`,
      // "missing" is a verdict, and a row that never ran has none. A participant reading doctor on a
      // fresh desktop got `- missing package.json: package.json is present and safe to read`, which
      // contradicts itself in eleven words (labs/tui-self-study.yaml).
      ...result.checks.map(
        (check) => `- ${check.status.replace("_", " ")} ${check.name}: ${check.message}`,
      ),
    ].join("\n") + "\n"
  );
}

function formatInitHuman(result: InitResult): string {
  const title = result.ok ? `humanish init ${result.mode}` : `humanish init ${result.mode} blocked`;
  const lines = [title, `cwd: ${result.cwd}`];
  if (result.ok && result.mode === "applied") {
    // A successful setup should leave its next action on the first terminal screen.
    // Dry-runs and refusals retain their full plan; JSON always retains every change.
    const counts = new Map<InitChange["action"], number>();
    for (const change of result.changes) {
      counts.set(change.action, (counts.get(change.action) ?? 0) + 1);
    }
    const labels: Record<InitChange["action"], string> = {
      create: "created",
      mkdir: "directories prepared",
      update: "updated",
      skip: "preserved",
    };
    lines.push(
      "",
      `changes: ${[...counts].map(([action, count]) => `${count} ${labels[action]}`).join(", ")}`,
      "Use humanish init --dry-run --json to inspect all files.",
    );
  } else {
    lines.push("", "changes:", ...result.changes.map(formatInitChange));
  }

  if (result.warnings.length > 0) {
    lines.push("", "warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  if (result.error) {
    lines.push("", `${result.error.code}: ${result.error.message}`);
  }

  if (result.mode === "needs-confirmation") {
    lines.push("", "Run with --dry-run --json to inspect or --yes to apply.");
  } else if (result.ok && result.nextSteps !== undefined) {
    // Twenty files and no next step is where the funnel died. Increasingly the reader here
    // is a coding agent doing setup for someone, and an agent does what stdout tells it to.
    lines.push(...result.nextSteps);
  }

  return `${lines.join("\n")}\n`;
}

function formatInitChange(change: InitChange): string {
  return `- ${change.action.padEnd(6)} ${change.path} (${change.target}: ${change.reason})`;
}
