import { spawn } from "node:child_process";
import path from "node:path";

import { digestText, tailText } from "../../evidence/redaction.js";
import {
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  type PreparedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/selected-output-paths.js";
import { CodexStdioClient, type CodexStdioHandlers } from "./app-server-client.js";
import {
  CodexTraceRecorder,
  isRecord,
  readNestedString,
  redactCodexEnvelope,
  renderTranscript,
  type CodexAppServerStatus,
  type CodexAppServerTrace,
  type JsonObject,
} from "./app-server-trace.js";

export interface CodexAppServerRunOptions {
  cwd: string;
  prompt: string;
  runRoot: string;
  timeoutMs: number;
  actorCommand?: string[];
  approvalPolicy?: "never" | "on-failure" | "on-request" | "untrusted";
  experimentalApi?: boolean;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  serviceName?: string;
}

export interface CodexAppServerRunResult {
  status: CodexAppServerStatus;
  reason: string;
  durationMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  model?: string;
  codexCliVersion?: string;
  experimentalApi: boolean;
  counts: CodexAppServerTrace["counts"];
  tail: string;
  trace: CodexAppServerTrace;
  transcriptPath: string;
  tracePath: string;
  eventsPath: string;
}

export async function runCodexAppServerSession(
  options: CodexAppServerRunOptions,
): Promise<CodexAppServerRunResult> {
  const preparedRunRoot = await prepareSelectedOutputDirectory(process.cwd(), options.runRoot);
  return runCodexAppServerSessionInPreparedRoot(options, preparedRunRoot);
}

/** Internal UI seam: the selected root was already prepared and must not be re-authorized. */
export async function runCodexAppServerSessionInPreparedRoot(
  options: CodexAppServerRunOptions,
  runRoot: PreparedOutputDirectory,
): Promise<CodexAppServerRunResult> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const artifacts = CODEX_APP_SERVER_ARTIFACTS;
  await prepareContainedOutputDirectory(runRoot, CODEX_APP_SERVER_DIRECTORY);
  await Promise.all([
    prepareContainedOutputFile(runRoot, artifacts.eventsPath),
    prepareContainedOutputFile(runRoot, artifacts.tracePath),
    prepareContainedOutputFile(runRoot, artifacts.transcriptPath),
  ]);
  const commandParts = resolveAppServerCommand(options.actorCommand);
  const childEnv = resolveCodexAppServerEnv(process.env);
  const apiKey = appServerApiKeyForLogin(childEnv);
  const child = spawn(commandParts.command, commandParts.args, {
    cwd: options.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const recorder = new CodexTraceRecorder({
    commandName: commandParts.name,
    cwd: options.cwd,
    experimentalApi: options.experimentalApi === true,
    promptDigest: digestText(options.prompt),
    startedAt: startedAt.toISOString(),
  });
  const envelopes: string[] = [];
  let completed = false;
  let timedOut = false;
  let completionStatus: string | undefined;
  let completionReason = "Codex app-server turn did not complete.";

  const client = new CodexStdioClient(
    child,
    `${commandParts.command} ${commandParts.args.join(" ")}`.trim(),
    recordingHandlers(recorder, envelopes, options.cwd, (message) => {
      if (message.method === "thread/started")
        recorder.recordThread(isRecord(message.params) ? message.params.thread : undefined);
      if (message.method === "turn/started")
        recorder.turnId = readNestedString(message, ["params", "turn", "id"]) ?? recorder.turnId;
      if (message.method === "turn/completed") {
        completionStatus = readNestedString(message, ["params", "turn", "status"]);
        completionReason = completionStatus
          ? `turn completed with status ${completionStatus}`
          : "turn completed";
        completed = true;
        child.kill("SIGTERM");
      }
    }),
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, options.timeoutMs);
  timeout.unref();

  const finish = async (
    status: CodexAppServerStatus,
    reason: string,
  ): Promise<CodexAppServerRunResult> => {
    clearTimeout(timeout);
    client.rejectPending(reason);
    const trace = recorder.buildTrace({
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      reason,
      status,
    });
    return writeRunArtifacts(runRoot, artifacts, envelopes, trace, client, status, reason);
  };

  try {
    const initialize = client.request("initialize", {
      clientInfo: {
        name: "humanish_cli",
        title: "Humanish CLI",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: options.experimentalApi === true,
      },
    });
    client.notify("initialized", {});
    await client.response(initialize, "initialize");
    if (apiKey) {
      await client.response(
        client.request("account/login/start", {
          type: "apiKey",
          apiKey,
        }),
        "account/login/start",
      );
    }
    const threadResponse = await client.response(
      client.request("thread/start", {
        cwd: options.cwd,
        approvalPolicy: normalizeApprovalPolicy(options.approvalPolicy),
        sandbox: normalizeSandbox(options.sandbox),
        serviceName: options.serviceName ?? "humanish",
        ...(options.model === undefined ? {} : { model: options.model }),
      }),
      "thread/start",
    );
    recorder.recordThread(threadResponse.thread, options.model);
    const threadId = recorder.threadId;
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    const turnResponse = await client.response(
      client.request("turn/start", {
        threadId,
        cwd: options.cwd,
        approvalPolicy: normalizeApprovalPolicy(options.approvalPolicy),
        sandboxPolicy: normalizeTurnSandbox(options.sandbox, options.cwd),
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
      }),
      "turn/start",
    );
    recorder.turnId = readNestedString(turnResponse, ["turn", "id"]) ?? recorder.turnId;

    // turn/completed and the timeout both signal the child, so every outcome waits for it to close.
    await client.closed;
    if (timedOut) {
      return finish("timed_out", `Codex app-server turn exceeded ${options.timeoutMs}ms timeout.`);
    }
    if (completed) {
      const status =
        completionStatus === "completed"
          ? "passed"
          : completionStatus === "failed"
            ? "failed"
            : "blocked";
      return finish(status, completionReason);
    }
    return finish(
      client.exitCode === 0 ? "passed" : "blocked",
      `Codex app-server process exited before turn completion${client.exitCode === undefined ? "" : ` with code ${client.exitCode}`}.`,
    );
  } catch (error) {
    child.kill("SIGTERM");
    await client.closed;
    return finish("blocked", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Client handlers that put every message into the trace and the redacted event log, decline server
 * requests by default, and pass notifications to `notification`.
 */
function recordingHandlers(
  recorder: CodexTraceRecorder,
  envelopes: string[],
  cwd: string,
  notification: (message: JsonObject) => void,
): CodexStdioHandlers {
  return {
    envelope: (direction, message) => {
      const redacted = redactCodexEnvelope(message, cwd);
      recorder.observeEnvelope(direction, redacted);
      envelopes.push(
        JSON.stringify({ at: new Date().toISOString(), direction, message: redacted }),
      );
      if (direction === "server") recorder.observeServerMessage(message);
    },
    serverRequest: (message) => {
      const result = defaultServerRequestResponse(message);
      recorder.recordApproval(message, result);
      return result;
    },
    notification,
    warning: (source, message) => recorder.addWarning(source, message),
    error: (source, message) => recorder.addError(source, message),
  };
}

/** Where a run writes its artifacts, relative to the run root; the UI prepares the same paths. */
export interface CodexAppServerArtifacts {
  eventsPath: string;
  tracePath: string;
  transcriptPath: string;
}
export const CODEX_APP_SERVER_DIRECTORY = "codex-app-server";
export const CODEX_APP_SERVER_ARTIFACTS: CodexAppServerArtifacts = {
  eventsPath: path.join(CODEX_APP_SERVER_DIRECTORY, "events.ndjson"),
  tracePath: path.join(CODEX_APP_SERVER_DIRECTORY, "summary.json"),
  transcriptPath: path.join(CODEX_APP_SERVER_DIRECTORY, "transcript.txt"),
};
/** Writes events.ndjson, summary.json and transcript.txt, then returns the result that names them. */
async function writeRunArtifacts(
  runRoot: PreparedOutputDirectory,
  artifacts: CodexAppServerArtifacts,
  envelopes: readonly string[],
  trace: CodexAppServerTrace,
  exit: { exitCode: number | undefined; signal: NodeJS.Signals | undefined },
  status: CodexAppServerStatus,
  reason: string,
): Promise<CodexAppServerRunResult> {
  const transcriptText = renderTranscript(trace);
  await writeContainedOutputFile(
    runRoot,
    artifacts.eventsPath,
    `${envelopes.join("\n")}${envelopes.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  await writeContainedOutputFile(
    runRoot,
    artifacts.tracePath,
    `${JSON.stringify(trace, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runRoot,
    artifacts.transcriptPath,
    transcriptText.length > 0
      ? transcriptText
      : "No Codex app-server transcript output captured.\n",
    "utf8",
  );
  return {
    status,
    reason,
    durationMs: trace.durationMs,
    ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
    ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    ...(trace.threadId === undefined ? {} : { threadId: trace.threadId }),
    ...(trace.turnId === undefined ? {} : { turnId: trace.turnId }),
    ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
    ...(trace.model === undefined ? {} : { model: trace.model }),
    ...(trace.server.codexCliVersion === undefined
      ? {}
      : { codexCliVersion: trace.server.codexCliVersion }),
    experimentalApi: trace.client.experimentalApi,
    counts: trace.counts,
    tail: tailText(transcriptText, 6_000),
    trace,
    ...artifacts,
  };
}

function resolveAppServerCommand(overrideCommand: string[] | undefined): {
  args: string[];
  command: string;
  name: string;
} {
  const commandParts =
    overrideCommand && overrideCommand.length > 0
      ? overrideCommand
      : ["codex", "app-server", "--listen", "stdio://"];
  const [command, ...args] = commandParts;
  return {
    command: command ?? "codex",
    args,
    name: path.basename(command ?? "codex"),
  };
}

function resolveCodexAppServerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const privateApiKey = env.HUMANISH_PRIVATE_CODEX_API_KEY?.trim();
  const privateAccessToken = env.HUMANISH_PRIVATE_CODEX_ACCESS_TOKEN?.trim();
  return {
    ...env,
    TERM: env.TERM ?? "xterm-256color",
    ...(privateApiKey && !env.CODEX_API_KEY ? { CODEX_API_KEY: privateApiKey } : {}),
    ...(privateApiKey && !env.OPENAI_API_KEY ? { OPENAI_API_KEY: privateApiKey } : {}),
    ...(privateAccessToken && !env.CODEX_ACCESS_TOKEN
      ? { CODEX_ACCESS_TOKEN: privateAccessToken }
      : {}),
  };
}

function appServerApiKeyForLogin(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.HUMANISH_PRIVATE_CODEX_API_KEY?.trim() ||
    env.CODEX_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    undefined
  );
}

function defaultServerRequestResponse(message: JsonObject): JsonObject {
  switch (message.method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "denied" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline" };
    default:
      return {};
  }
}

function normalizeApprovalPolicy(value: CodexAppServerRunOptions["approvalPolicy"]): string {
  if (value === "on-failure") return "on-failure";
  if (value === "on-request") return "on-request";
  if (value === "untrusted") return "untrusted";
  return "never";
}

function normalizeSandbox(value: CodexAppServerRunOptions["sandbox"]): string {
  if (value === "danger-full-access") return "danger-full-access";
  if (value === "workspace-write") return "workspace-write";
  return "read-only";
}

function normalizeTurnSandbox(value: CodexAppServerRunOptions["sandbox"], cwd: string): JsonObject {
  const mode = normalizeSandbox(value);
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  return { type: "readOnly", networkAccess: false };
}
