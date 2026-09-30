import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { startCodexAppServerUi } from "../../actors/codex/app-server-ui.js";
import type { CodexAppServerUiState } from "../../actors/codex/app-server-ui.js";
import { redactText } from "../../evidence/redaction.js";
import {
  type CliIo,
  JSON_OPTION_DESCRIPTION,
  parseObserverPort,
  parseTimeoutMs,
  writeResult,
} from "../io.js";

interface CodexAppServerUiCliResult {
  schema: "humanish.codex-app-server-ui-result.v1";
  ok: boolean;
  cwd: string;
  reason: string;
  stateFile?: string;
  status?: string;
  url?: string;
  error?: {
    code:
      | "HUMANISH_CODEX_APP_SERVER_PROMPT_REQUIRED"
      | "HUMANISH_INVALID_PORT"
      | "HUMANISH_INVALID_TIMEOUT";
    message: string;
  };
}

export function registerCodexCommands(parent: Command, io: CliIo): void {
  const codex = parent
    .command("codex")
    .description("Run Codex-native humanish integration surfaces.")
    .summary("Run Codex-native humanish integration surfaces.");

  codex
    .command("app-server")
    .description(
      "Run a browser-visible Codex app-server actor surface and write redacted protocol artifacts.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--prompt <text>", "Prompt to submit to Codex app-server.")
    .option("--prompt-file <path>", "Read the Codex app-server prompt from a file.")
    .option("--run-root <path>", "Artifact directory for redacted app-server evidence.")
    .option("--state-file <path>", "State JSON file for external observers.")
    .option("--timeout-ms <ms>", "Actor timeout in milliseconds.", String(900_000))
    .option("--port <port>", "Local browser UI port.", "0")
    .option("--model <model>", "Optional Codex model override.")
    .addOption(
      new Option("--sandbox <mode>", "Turn sandbox policy.")
        .choices(["read-only", "workspace-write", "danger-full-access"])
        .default("read-only"),
    )
    .option(
      "--actor-command <command>",
      "Override app-server command. Defaults to codex app-server --listen stdio://.",
    )
    .option("--keep-open", "Keep the browser UI process alive after the actor finishes.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          actorCommand?: string;
          cwd: string;
          json?: boolean;
          keepOpen?: boolean;
          model?: string;
          port: string;
          prompt?: string;
          promptFile?: string;
          runRoot?: string;
          sandbox: "read-only" | "workspace-write" | "danger-full-access";
          stateFile?: string;
          timeoutMs: string;
        },
        command,
      ) => {
        const timeoutMs = parseTimeoutMs(options.timeoutMs);
        const port = parseObserverPort(options.port);
        if (timeoutMs === null) {
          const result = codexAppServerUiError(
            options.cwd,
            "HUMANISH_INVALID_TIMEOUT",
            "--timeout-ms must be an integer between 1 and 3600000.",
          );
          writeResult(command, io, result, formatCodexAppServerUiHuman);
          io.setExitCode(2);
          return;
        }
        if (port === null) {
          const result = codexAppServerUiError(
            options.cwd,
            "HUMANISH_INVALID_PORT",
            "--port must be an integer between 0 and 65535.",
          );
          writeResult(command, io, result, formatCodexAppServerUiHuman);
          io.setExitCode(2);
          return;
        }

        const prompt = await readCodexAppServerPrompt(options);
        if (!prompt) {
          const result = codexAppServerUiError(
            options.cwd,
            "HUMANISH_CODEX_APP_SERVER_PROMPT_REQUIRED",
            "Provide --prompt or --prompt-file.",
          );
          writeResult(command, io, result, formatCodexAppServerUiHuman);
          io.setExitCode(2);
          return;
        }

        const controller = await startCodexAppServerUi({
          ...(options.actorCommand === undefined ? {} : { actorCommand: options.actorCommand }),
          cwd: options.cwd,
          keepOpen: options.keepOpen === true,
          ...(options.model === undefined ? {} : { model: options.model }),
          port,
          prompt,
          ...(options.runRoot === undefined ? {} : { runRoot: options.runRoot }),
          sandbox: options.sandbox,
          ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
          timeoutMs,
        });

        const initial = {
          schema: "humanish.codex-app-server-ui-result.v1" as const,
          ok: true,
          cwd: resolve(options.cwd),
          stateFile: controller.stateFile,
          url: controller.url,
          status: controller.initialState.status,
          reason: controller.initialState.reason,
        };
        if (options.keepOpen === true) {
          writeResult(command, io, initial, formatCodexAppServerUiHuman);
          io.setExitCode(0);
          try {
            // Local hardening for the known double-envelope path: the "running"
            // envelope above has already reached stdout, so a rejection here
            // (src/actors/codex/app-server-ui.ts's persistState() write can fail on either
            // branch of session completion) must not go through the
            // command-boundary catch-all's --json branch, which would otherwise
            // append a second JSON document to stdout. Handling it here directly
            // means this known path stays correct even if that general guard is
            // ever weakened; it does not replace it.
            await controller.completion;
            await new Promise<void>((resolveWait) => {
              process.once("SIGINT", () => {
                void controller.close().finally(resolveWait);
              });
            });
          } catch (error) {
            io.writeErr(
              `HUMANISH_UNEXPECTED: ${redactText(error instanceof Error ? error.message : String(error))}\n`,
            );
            io.setExitCode(2);
          }
          return;
        }

        const completed = await controller.completion;
        const output = codexAppServerUiResultFromState(completed);
        writeResult(command, io, output, formatCodexAppServerUiHuman);
        io.setExitCode(output.ok ? 0 : 2);
      },
    );
}

function formatCodexAppServerUiHuman(result: CodexAppServerUiCliResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return (
    [
      "humanish codex app-server",
      `url: ${result.url ?? "not-started"}`,
      `status: ${result.status ?? "unknown"}`,
      `state: ${result.stateFile ?? "none"}`,
      `reason: ${result.reason}`,
    ].join("\n") + "\n"
  );
}

async function readCodexAppServerPrompt(options: {
  cwd: string;
  prompt?: string;
  promptFile?: string;
}): Promise<string | null> {
  if (options.prompt !== undefined && options.prompt.trim()) {
    return options.prompt;
  }
  if (options.promptFile !== undefined && options.promptFile.trim()) {
    const promptPath = resolve(options.cwd, options.promptFile);
    const text = await readFile(promptPath, "utf8");
    return text.trim() || null;
  }
  return null;
}

function codexAppServerUiError(
  cwd: string,
  code: NonNullable<CodexAppServerUiCliResult["error"]>["code"],
  message: string,
): CodexAppServerUiCliResult {
  return {
    schema: "humanish.codex-app-server-ui-result.v1",
    ok: false,
    cwd: resolve(cwd),
    reason: message,
    error: { code, message },
  };
}

function codexAppServerUiResultFromState(state: CodexAppServerUiState): CodexAppServerUiCliResult {
  return {
    schema: "humanish.codex-app-server-ui-result.v1",
    ok: state.status === "passed",
    cwd: state.cwd,
    reason: state.reason,
    stateFile: state.stateFile,
    status: state.status,
    ...(state.url === undefined ? {} : { url: state.url }),
  };
}
