import { Command } from "commander";
import {
  listUserKeys,
  resolveKeyName,
  setUserKey,
  unsetUserKey,
  userKeyStorePath,
} from "../../keys/key-resolution.js";
import { askForMissingKeys, formatKeyStatus, keyStatus } from "../../keys/key-status.js";
import { promptSecret } from "../secret-prompt.js";
import { runInit } from "../../study/init.js";
import {
  buildPayload,
  disabledByEnvironment,
  readTelemetryState,
  telemetryStatePath,
  writeTelemetryState,
} from "../telemetry.js";
import type { InitChange, InitResult } from "../../study/init.js";
import { doctor } from "../doctor.js";
import type { DoctorResult } from "../doctor.js";
import type { DotenvLoad } from "../../keys/key-resolution.js";
import {
  applyEnvFileOption,
  CLI_VERSION,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  DOTENV_OPTION_DESCRIPTION,
  dotenvPathOf,
  envFileAliasOption,
  JSON_OPTION_DESCRIPTION,
  markInvocationEnvelopeWritten,
  wantsJson,
  writeResult,
  formatCliError,
  type HumanOutput,
} from "../io.js";
import { plural } from "../../run/text.js";
import { cli } from "../invocation.js";

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
    .summary("Check what this project and machine need for a run.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option(
      "--study <study>",
      "Check the study's desktop, participant authentication and separate analysis requirements; no provider calls.",
    )
    .option("--dotenv <path>", DOTENV_OPTION_DESCRIPTION)
    .addOption(envFileAliasOption())
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          cwd: string;
          study?: string;
          dotenv?: string;
          envFile?: string;
          json?: boolean;
        },
        command,
      ) => {
        const dotenv = dotenvPathOf(options, command, io);
        let loaded: DotenvLoad | undefined;
        if (
          dotenv &&
          !(await applyEnvFileOption({
            command,
            cwd: options.cwd,
            envFile: dotenv,
            io,
            onLoaded: (load) => {
              loaded = load;
            },
          }))
        )
          return;
        const result = await doctor(options.cwd, {
          ...(options.study ? { study: options.study } : {}),
          ...(loaded === undefined ? {} : { dotenv: loaded }),
        });
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
          command: "run",
          study: "try-live",
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
            "every field that is sent, with example values:",
            JSON.stringify(sample, null, 2),
            "",
            "never sent: studies you wrote, subjects, personas, missions, paths, run evidence, key names or values.",
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
  action: "status" | "set" | "unset" | "list";
  /** The user store path (with values never included anywhere in this envelope). */
  store: string;
  /** `list`: the names present in the store. `set`/`unset`: the affected names. `status`: the
   *  names that are set. */
  names: string[];
  /** `status`: every provider key, with the source that supplies it or the command that adds it. */
  keys?: Array<{ name: string; use: string; source: string | null; hint?: string }>;
  message: string;
}

function formatKeysHuman(result: KeysResult): HumanOutput {
  if (!result.ok) return { error: { message: result.message } };
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
  // An empty line is no value here: only the walk over missing keys reads it as "skip".
  return (await promptSecret(promptLabel, process.stdin, process.stderr)) || null;
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * `humanish keys set` with no key named. On a terminal it asks for each missing provider key in
 * turn; without one there is no one to ask, so it refuses and names the --stdin form.
 */
async function setMissingKeys(command: Command, io: CliIo, useStdin: boolean): Promise<void> {
  const store = userKeyStorePath(process.env);
  const finish = (ok: boolean, names: string[], message: string): void => {
    const result: KeysResult = {
      schema: KEYS_RESULT_SCHEMA,
      ok,
      action: "set",
      store,
      names,
      message,
    };
    writeResult(command, io, result, formatKeysHuman);
    io.setExitCode(ok ? 0 : 2);
  };
  if (useStdin || process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    finish(
      false,
      [],
      `missing required argument 'vendor-or-name'. Without a terminal humanish cannot ask for each key, so name the key and pipe its value, for example: printf '%s' "$E2B_API_KEY" | ${cli("keys set e2b --stdin")}`,
    );
    return;
  }
  const rows = await keyStatus({ cwd: process.cwd(), env: process.env });
  const missing = rows.filter((row) => row.source === null).length;
  if (missing === 0) {
    finish(
      true,
      [],
      `Every provider key is already set, so there is nothing to ask for. Replace one with \`${cli("keys set <vendor>")}\`.`,
    );
    return;
  }
  io.writeErr(
    `${plural(missing, "provider key")} ${missing === 1 ? "is" : "are"} missing. Paste each one when asked, or press Enter to skip it.\n`,
  );
  const outcome = await askForMissingKeys({
    rows,
    env: process.env,
    prompt: (label) => promptSecret(label, process.stdin, process.stderr),
  });
  const sentences = [
    outcome.stored.length > 0
      ? `Stored ${listNames(outcome.stored)} (0600).`
      : "Nothing was stored.",
    ...(outcome.skipped.length > 0 ? [`Skipped ${listNames(outcome.skipped)}.`] : []),
    ...(outcome.rejected ?? []).map((entry) => `${entry.name} was not stored: ${entry.message}`),
    ...(outcome.stoppedAt === undefined
      ? []
      : [`Stopped at ${outcome.stoppedAt}; the keys after it were not asked for.`]),
    `\`${cli("keys")}\` shows where each key comes from.`,
  ];
  // A cancel is the person's choice, so only a value the store refused fails the command.
  finish(outcome.rejected === undefined, outcome.stored, sentences.join(" "));
}

export function registerKeysCommand(parent: Command, io: CliIo): void {
  const keys = parent
    .command("keys")
    .description(
      "Show which provider keys are set and where each comes from, and manage the humanish user key store that provider-key discovery reads.",
    )
    .summary("Check and store your provider keys.");

  keys
    .command("status", { isDefault: true })
    .description(
      "Show each provider key humanish uses: where it comes from, or the command that adds it. Values are never printed.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (_options: { json?: boolean }, command) => {
      const rows = await keyStatus({ cwd: process.cwd(), env: process.env });
      const missing = rows.filter((row) => row.source === null).length;
      const result: KeysResult = {
        schema: KEYS_RESULT_SCHEMA,
        ok: true,
        action: "status",
        store: userKeyStorePath(process.env),
        names: rows.filter((row) => row.source !== null).map((row) => row.name),
        keys: rows.map(({ name, use, source, hint }) => ({
          name,
          use,
          source,
          ...(source === null ? { hint } : {}),
        })),
        message:
          missing === 0
            ? "Every provider key is set."
            : `${plural(missing, "provider key")} ${missing === 1 ? "is" : "are"} missing.`,
      };
      writeResult(command, io, result, () => formatKeyStatus(rows));
      io.setExitCode(0);
    });

  keys
    .command("set")
    .argument(
      "[vendor-or-name]",
      "A vendor alias (openai, e2b, anthropic, github, agentmail) or a raw ENV_NAME. Without one, a terminal asks for each missing key in turn.",
    )
    .description(
      "Store one provider key in the user store (0600), prompted with hidden input. With no key named, ask for each missing key in turn.",
    )
    .option("--stdin", "Read the value from stdin instead of prompting (for agents/pipes).")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        vendorOrName: string | undefined,
        options: { stdin?: boolean; json?: boolean },
        command,
      ) => {
        if (vendorOrName === undefined) {
          await setMissingKeys(command, io, options.stdin === true);
          return;
        }
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
      },
    );

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
    .description("List the key names in the user store. Values are never printed.")
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
            ? `The store is empty. Add a key with \`${cli("keys set <vendor>")}\`.`
            : `${plural(names.length, "key name")} stored. Values are never printed.`,
      };
      writeResult(command, io, result, formatKeysHuman);
      io.setExitCode(0);
    });
}

function formatDoctorHuman(result: DoctorResult): string {
  return (
    [
      `humanish doctor ${result.ok ? "ok" : "needs setup"}`,
      ...(result.next === undefined ? [] : [`next: ${result.next}`]),
      `cwd: ${result.cwd}`,
      // "missing" is a verdict, and a row that never ran has none. A participant reading doctor on a
      // fresh desktop got `- missing package.json: package.json is present and safe to read`, which
      // contradicts itself in eleven words (labs/tui-self-study.yaml).
      ...result.checks.map(
        (check) =>
          `- ${check.status.replace("_", " ")} ${check.name}: ${check.message.replaceAll("\n", "\n    ")}`,
      ),
    ].join("\n") + "\n"
  );
}

function formatInitHuman(result: InitResult): string {
  const title = result.ok ? `humanish init ${result.mode}` : `humanish init ${result.mode} blocked`;
  const lines = [title, `cwd: ${result.cwd}`];
  if (result.ok && result.mode === "applied") {
    // Name each file init wrote, so the person or agent who ran it can review exactly those
    // files; directories and preserved files are counts. JSON always carries every change.
    const files = (action: InitChange["action"]) =>
      result.changes.filter((change) => change.action === action && change.target !== "runtime");
    const created = files("create");
    const updated = files("update");
    const preserved = result.changes.filter((change) => change.action === "skip").length;
    const directories = result.changes.filter((change) => change.action === "mkdir").length;
    lines.push("");
    if (created.length > 0) lines.push("created:", ...created.map((change) => `  ${change.path}`));
    if (updated.length > 0)
      lines.push("updated:", ...updated.map((change) => `  ${change.path} (${change.reason})`));
    if (created.length === 0 && updated.length === 0) lines.push("no files changed");
    if (preserved > 0 || directories > 0)
      lines.push(
        [
          ...(preserved > 0 ? [`${plural(preserved, "existing path")} unchanged`] : []),
          ...(directories > 0
            ? [`${plural(directories, "ignored directory", "ignored directories")} prepared`]
            : []),
        ].join(", "),
      );
  } else {
    lines.push("", "changes:", ...result.changes.map(formatInitChange));
  }

  if (result.warnings.length > 0) {
    lines.push("", "warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  // init writes a refused plan to stderr, so the error goes there in the shared shape.
  if (result.error) lines.push("", formatCliError("humanish init", result.error).trimEnd());

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
