import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { digestText, publicPathForTrace, redactText, tailText } from "./redaction.js";

export const CODEX_APP_SERVER_TRACE_SCHEMA = "humanish.codex-app-server-trace.v1";

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string;

export type CodexAppServerStatus = "passed" | "failed" | "blocked" | "timed_out";

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

export interface CodexAppServerTrace {
  schema: typeof CODEX_APP_SERVER_TRACE_SCHEMA;
  provider: "codex-app-server";
  protocolVersion: "v2";
  redaction: {
    status: "passed";
    notes: string;
  };
  client: {
    name: "humanish_cli";
    title: "Humanish CLI";
    experimentalApi: boolean;
  };
  server: {
    commandName: string;
    codexCliVersion?: string;
    transport: "stdio";
  };
  cwd: string;
  promptDigest: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: CodexAppServerStatus;
  reason: string;
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  model?: string;
  counts: {
    approvals: number;
    commandOutputs: number;
    envelopes: number;
    errors: number;
    fileChanges: number;
    itemCompletions: number;
    itemStarts: number;
    messages: number;
    reasoning: number;
    requests: number;
    responses: number;
    tools: number;
    warnings: number;
  };
  methods: Record<string, number>;
  items: CodexTraceItem[];
  messages: CodexTraceText[];
  reasoning: CodexTraceText[];
  plans: CodexTracePlan[];
  commands: CodexTraceCommand[];
  fileChanges: CodexTraceFileChange[];
  tools: CodexTraceToolCall[];
  approvals: CodexTraceApproval[];
  warnings: CodexTraceNotice[];
  errors: CodexTraceNotice[];
  tokenUsage?: JsonObject;
}

export interface CodexTraceItem {
  id: string;
  type: string;
  status?: string;
  lifecycle: "started" | "completed";
  title: string;
}

export interface CodexTraceText {
  itemId: string;
  text: string;
}

export interface CodexTracePlan {
  explanation?: string;
  steps: string[];
}

export interface CodexTraceCommand {
  itemId: string;
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
  outputTail?: string;
}

export interface CodexTraceFileChange {
  itemId: string;
  status?: string;
  changeCount?: number;
  outputTail?: string;
}

export interface CodexTraceToolCall {
  itemId: string;
  kind: "mcp" | "dynamic" | "unknown";
  server?: string;
  tool?: string;
  status?: string;
}

export interface CodexTraceApproval {
  id: JsonRpcId;
  method: string;
  itemId?: string;
  decision: "decline" | "denied" | "empty";
  reason: string;
}

export interface CodexTraceNotice {
  method: string;
  message: string;
}

const authLikeKey = /(api[_-]?key|access[_-]?token|auth[_-]?url|authorization|bearer|credential|password|secret|token)$/i;
const pathLikeKey = /^(cwd|path|writableRoots|workspaceRoot)$/i;

export async function runCodexAppServerSession(
  options: CodexAppServerRunOptions
): Promise<CodexAppServerRunResult> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const relativeDir = "codex-app-server";
  const eventsPath = path.join(relativeDir, "events.ndjson");
  const tracePath = path.join(relativeDir, "summary.json");
  const transcriptPath = path.join(relativeDir, "transcript.txt");
  const absoluteEventsPath = path.join(options.runRoot, eventsPath);
  const absoluteTracePath = path.join(options.runRoot, tracePath);
  const absoluteTranscriptPath = path.join(options.runRoot, transcriptPath);
  const commandParts = resolveAppServerCommand(options.actorCommand);
  const childEnv = resolveCodexAppServerEnv(process.env);
  const apiKey = appServerApiKeyForLogin(childEnv);
  const child = spawn(commandParts.command, commandParts.args, {
    cwd: options.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const recorder = new CodexTraceRecorder({
    commandName: commandParts.name,
    cwd: options.cwd,
    experimentalApi: options.experimentalApi === true,
    promptDigest: digestText(options.prompt),
    startedAt: startedAt.toISOString()
  });
  const envelopes: string[] = [];
  let transcript = "";
  let nextId = 1;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let completed = false;
  let timedOut = false;
  let processError: Error | undefined;
  let stdinError: Error | undefined;
  let exitCode: number | undefined;
  let signal: NodeJS.Signals | undefined;
  let completionStatus: string | undefined;
  let completionReason = "Codex app-server turn did not complete.";
  const pending = new Map<JsonRpcId, {
    reject: (error: Error) => void;
    resolve: (value: JsonObject) => void;
  }>();

  await mkdir(path.dirname(absoluteEventsPath), { recursive: true });

  const appendEnvelope = (direction: "client" | "server", message: unknown): void => {
    const redacted = redactCodexEnvelope(message, options.cwd);
    recorder.observeEnvelope(direction, redacted);
    envelopes.push(JSON.stringify({
      at: new Date().toISOString(),
      direction,
      message: redacted
    }));
  };

  const send = (message: JsonObject): void => {
    appendEnvelope("client", message);
    if (child.stdin.destroyed || stdinError || processError) {
      throw stdinError ?? processError ?? new Error("Codex app-server stdin is closed.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !stdinError) {
        stdinError = error;
        recorder.addWarning("stdin", redactText(error.message).slice(0, 1_000));
      }
    });
  };

  const request = (method: string, params: JsonObject | undefined): Promise<JsonObject> => {
    const id = nextId;
    nextId += 1;
    const message: JsonObject = params === undefined
      ? { method, id }
      : { method, id, params };
    const promise = new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send(message);
    return promise;
  };

  const respond = (id: JsonRpcId, result: JsonObject): void => {
    send({ id, result });
  };

  const rl = readline.createInterface({ input: child.stdout });
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      processError = error;
      recorder.addError("process", redactText(error.message).slice(0, 1_000));
    });
    child.once("close", (code, childSignal) => {
      exitCode = code === null ? undefined : code;
      signal = childSignal === null ? undefined : childSignal;
      resolve();
    });
  });
  child.stdin.on("error", (error) => {
    stdinError = error;
    recorder.addWarning("stdin", redactText(error.message).slice(0, 1_000));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, options.timeoutMs);
  timeout.unref();

  child.stderr.on("data", (chunk: Buffer) => {
    const text = redactText(chunk.toString("utf8"));
    if (text.trim()) {
      recorder.addWarning("stderr", text.trim().slice(0, 1_000));
      transcript = limitTranscript(`${transcript}${text}`);
    }
  });

  rl.on("line", (line) => {
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(line) as JsonObject;
    } catch {
      recorder.addWarning("parse", "Received non-JSON app-server output line.");
      transcript = limitTranscript(`${transcript}${redactText(line)}\n`);
      return;
    }

    appendEnvelope("server", parsed);
    recorder.observeServerMessage(parsed);

    const id = parsed.id;
    if (typeof id === "number" || typeof id === "string") {
      if (typeof parsed.method === "string") {
        const result = defaultServerRequestResponse(parsed);
        recorder.recordApproval(parsed, result);
        respond(id, result);
        return;
      }

      const pendingRequest = pending.get(id);
      if (pendingRequest) {
        pending.delete(id);
        if (isRecord(parsed.error)) {
          pendingRequest.reject(new Error(formatJsonRpcError(parsed.error)));
        } else {
          pendingRequest.resolve(isRecord(parsed.result) ? parsed.result : {});
        }
      }
    }

    if (parsed.method === "thread/started") {
      threadId = readNestedString(parsed, ["params", "thread", "id"]) ?? threadId;
      recorder.threadId = threadId;
      recorder.sessionId = readNestedString(parsed, ["params", "thread", "sessionId"]) ?? recorder.sessionId;
      recorder.model = readNestedString(parsed, ["params", "thread", "model"]) ?? recorder.model;
      recorder.codexCliVersion = readNestedString(parsed, ["params", "thread", "cliVersion"]) ?? recorder.codexCliVersion;
    }

    if (parsed.method === "turn/started") {
      turnId = readNestedString(parsed, ["params", "turn", "id"]) ?? turnId;
      recorder.turnId = turnId;
    }

    if (parsed.method === "turn/completed") {
      completionStatus = readNestedString(parsed, ["params", "turn", "status"]);
      completionReason = completionStatus ? `turn completed with status ${completionStatus}` : "turn completed";
      completed = true;
      child.kill("SIGTERM");
    }
  });

  const finish = async (status: CodexAppServerStatus, reason: string): Promise<CodexAppServerRunResult> => {
    clearTimeout(timeout);
    for (const pendingRequest of pending.values()) {
      pendingRequest.reject(new Error(reason));
    }
    pending.clear();
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    const trace = recorder.buildTrace({
      completedAt,
      durationMs,
      reason,
      status
    });
    const transcriptText = recorder.renderTranscript();
    await writeFile(absoluteEventsPath, `${envelopes.join("\n")}${envelopes.length > 0 ? "\n" : ""}`, "utf8");
    await writeFile(absoluteTracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    await writeFile(absoluteTranscriptPath, transcriptText.length > 0 ? transcriptText : "No Codex app-server transcript output captured.\n", "utf8");
    return {
      status,
      reason,
      durationMs,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
      ...(trace.threadId === undefined ? {} : { threadId: trace.threadId }),
      ...(trace.turnId === undefined ? {} : { turnId: trace.turnId }),
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(trace.model === undefined ? {} : { model: trace.model }),
      ...(trace.server.codexCliVersion === undefined ? {} : { codexCliVersion: trace.server.codexCliVersion }),
      experimentalApi: trace.client.experimentalApi,
      counts: trace.counts,
      tail: tailText(transcriptText, 6_000),
      trace,
      transcriptPath,
      tracePath,
      eventsPath
    };
  };

  const waitForResponse = async (promise: Promise<JsonObject>, method: string): Promise<JsonObject> => Promise.race([
    promise,
    closed.then(() => {
      const commandName = `${commandParts.command} ${commandParts.args.join(" ")}`.trim();
      const detail = processError?.message
        ?? stdinError?.message
        ?? (exitCode === undefined ? "without an exit code" : `with code ${exitCode}`);
      throw new Error(`Codex app-server command '${commandName}' exited during ${method} ${detail}.`);
    })
  ]);

  try {
    const initialize = request("initialize", {
      clientInfo: {
        name: "humanish_cli",
        title: "Humanish CLI",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: options.experimentalApi === true
      }
    });
    send({ method: "initialized", params: {} });
    await waitForResponse(initialize, "initialize");
    if (apiKey) {
      await waitForResponse(request("account/login/start", {
        type: "apiKey",
        apiKey
      }), "account/login/start");
    }
    const threadResponse = await waitForResponse(request("thread/start", {
      cwd: options.cwd,
      approvalPolicy: normalizeApprovalPolicy(options.approvalPolicy),
      sandbox: normalizeSandbox(options.sandbox),
      serviceName: options.serviceName ?? "humanish",
      ...(options.model === undefined ? {} : { model: options.model })
    }), "thread/start");
    threadId = readNestedString(threadResponse, ["thread", "id"]) ?? threadId;
    recorder.threadId = threadId;
    recorder.sessionId = readNestedString(threadResponse, ["thread", "sessionId"]) ?? recorder.sessionId;
    recorder.model = readNestedString(threadResponse, ["thread", "model"]) ?? options.model ?? recorder.model;
    recorder.codexCliVersion = readNestedString(threadResponse, ["thread", "cliVersion"]) ?? recorder.codexCliVersion;
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    const turnResponse = await waitForResponse(request("turn/start", {
      threadId,
      cwd: options.cwd,
      approvalPolicy: normalizeApprovalPolicy(options.approvalPolicy),
      sandboxPolicy: normalizeTurnSandbox(options.sandbox, options.cwd),
      input: [
        { type: "text", text: options.prompt, text_elements: [] }
      ]
    }), "turn/start");
    turnId = readNestedString(turnResponse, ["turn", "id"]) ?? turnId;
    recorder.turnId = turnId;

    while (!completed && !timedOut) {
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 100))
      ]);
      if (exitCode !== undefined || signal !== undefined) {
        break;
      }
    }

    if (timedOut) {
      await closed;
      return finish("timed_out", `Codex app-server turn exceeded ${options.timeoutMs}ms timeout.`);
    }

    if (completed) {
      await closed;
      const status = completionStatus === "completed"
        ? "passed"
        : completionStatus === "failed"
          ? "failed"
          : "blocked";
      return finish(status, completionReason);
    }

    await closed;
    return finish(exitCode === 0 ? "passed" : "blocked", `Codex app-server process exited before turn completion${exitCode === undefined ? "" : ` with code ${exitCode}`}.`);
  } catch (error) {
    child.kill("SIGTERM");
    await closed;
    return finish("blocked", error instanceof Error ? error.message : String(error));
  }
}

function resolveAppServerCommand(overrideCommand: string[] | undefined): { args: string[]; command: string; name: string } {
  const commandParts = overrideCommand && overrideCommand.length > 0
    ? overrideCommand
    : ["codex", "app-server", "--listen", "stdio://"];
  const [command, ...args] = commandParts;
  return {
    command: command ?? "codex",
    args,
    name: path.basename(command ?? "codex")
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
    ...(privateAccessToken && !env.CODEX_ACCESS_TOKEN ? { CODEX_ACCESS_TOKEN: privateAccessToken } : {})
  };
}

function appServerApiKeyForLogin(env: NodeJS.ProcessEnv): string | undefined {
  return env.HUMANISH_PRIVATE_CODEX_API_KEY?.trim()
    || env.CODEX_API_KEY?.trim()
    || env.OPENAI_API_KEY?.trim()
    || undefined;
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
      excludeSlashTmp: false
    };
  }
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  return { type: "readOnly", networkAccess: false };
}

class CodexTraceRecorder {
  private readonly commandOutputs = new Map<string, string>();
  private readonly fileOutputs = new Map<string, string>();
  private readonly messageDeltas = new Map<string, string>();
  private readonly reasoningDeltas = new Map<string, string>();
  private readonly rootCwd: string;
  private readonly trace: Omit<CodexAppServerTrace, "completedAt" | "durationMs" | "reason" | "status">;

  public codexCliVersion: string | undefined;
  public model: string | undefined;
  public sessionId: string | undefined;
  public threadId: string | undefined;
  public turnId: string | undefined;

  public constructor(args: {
    commandName: string;
    cwd: string;
    experimentalApi: boolean;
    promptDigest: string;
    startedAt: string;
  }) {
    this.rootCwd = args.cwd;
    this.trace = {
      schema: CODEX_APP_SERVER_TRACE_SCHEMA,
      provider: "codex-app-server",
      protocolVersion: "v2",
      redaction: {
        status: "passed",
        notes: "Trace envelopes and text were redacted before persistence. App-server schemas are version-specific and are not embedded in this run artifact."
      },
      client: {
        name: "humanish_cli",
        title: "Humanish CLI",
        experimentalApi: args.experimentalApi
      },
      server: {
        commandName: args.commandName,
        transport: "stdio"
      },
      cwd: publicPathForTrace(args.cwd, args.cwd),
      promptDigest: args.promptDigest,
      startedAt: args.startedAt,
      counts: {
        approvals: 0,
        commandOutputs: 0,
        envelopes: 0,
        errors: 0,
        fileChanges: 0,
        itemCompletions: 0,
        itemStarts: 0,
        messages: 0,
        reasoning: 0,
        requests: 0,
        responses: 0,
        tools: 0,
        warnings: 0
      },
      methods: {},
      items: [],
      messages: [],
      reasoning: [],
      plans: [],
      commands: [],
      fileChanges: [],
      tools: [],
      approvals: [],
      warnings: [],
      errors: []
    };
  }

  public observeEnvelope(direction: "client" | "server", message: unknown): void {
    this.trace.counts.envelopes += 1;
    if (direction === "client") {
      this.trace.counts.requests += isRecord(message) && "id" in message ? 1 : 0;
    } else if (isRecord(message) && "id" in message && !("method" in message)) {
      this.trace.counts.responses += 1;
    }
    const method = isRecord(message) && typeof message.method === "string" ? message.method : direction === "server" ? "response" : "request";
    this.trace.methods[method] = (this.trace.methods[method] ?? 0) + 1;
  }

  public observeServerMessage(message: JsonObject): void {
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "error") {
      this.addError(method, readNestedString(message, ["params", "message"]) ?? "App-server emitted an error notification.");
    }
    if (method === "warning" || method === "guardianWarning" || method === "configWarning") {
      this.addWarning(method, readNestedString(message, ["params", "message"]) ?? `App-server emitted ${method}.`);
    }
    if (method === "thread/tokenUsage/updated") {
      if (isRecord(message.params)) {
        this.trace.tokenUsage = message.params;
      }
    }
    if (method === "item/started" || method === "item/completed") {
      this.recordItem(message, method === "item/started" ? "started" : "completed");
    }
    if (method === "item/agentMessage/delta") {
      this.appendText(this.messageDeltas, message);
      this.trace.counts.messages += 1;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.appendText(this.reasoningDeltas, message);
      this.trace.counts.reasoning += 1;
    }
    if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta" || method === "process/outputDelta") {
      this.appendText(this.commandOutputs, message);
      this.trace.counts.commandOutputs += 1;
    }
    if (method === "item/fileChange/outputDelta") {
      this.appendText(this.fileOutputs, message);
    }
    if (method === "turn/plan/updated") {
      this.recordPlan(message);
    }
  }

  public recordApproval(message: JsonObject, response: JsonObject): void {
    this.trace.counts.approvals += 1;
    const itemId = readNestedString(message, ["params", "itemId"]);
    this.trace.approvals.push({
      id: message.id as JsonRpcId,
      method: typeof message.method === "string" ? message.method : "unknown",
      ...(itemId === undefined ? {} : { itemId }),
      decision: typeof response.decision === "string" && response.decision === "denied" ? "denied" : typeof response.decision === "string" ? "decline" : "empty",
      reason: "Humanish records app-server approval requests and declines by default unless a future explicit policy says otherwise."
    });
  }

  public addWarning(method: string, message: string): void {
    this.trace.counts.warnings += 1;
    this.trace.warnings.push({ method, message: redactText(message) });
  }

  public addError(method: string, message: string): void {
    this.trace.counts.errors += 1;
    this.trace.errors.push({ method, message: redactText(message) });
  }

  public buildTrace(args: {
    completedAt: string;
    durationMs: number;
    reason: string;
    status: CodexAppServerStatus;
  }): CodexAppServerTrace {
    const messages = Array.from(this.messageDeltas.entries())
      .filter(([, text]) => text.trim() !== "")
      .map(([itemId, text]) => ({ itemId, text: redactText(text) }));
    const reasoning = Array.from(this.reasoningDeltas.entries())
      .filter(([, text]) => text.trim() !== "")
      .map(([itemId, text]) => ({ itemId, text: redactText(text) }));
    const commands = this.trace.commands.map((command) => ({
      ...command,
      outputTail: tailText(redactText(this.commandOutputs.get(command.itemId) ?? command.outputTail ?? ""), 2_000)
    }));
    const fileChanges = this.trace.fileChanges.map((fileChange) => ({
      ...fileChange,
      outputTail: tailText(redactText(this.fileOutputs.get(fileChange.itemId) ?? fileChange.outputTail ?? ""), 2_000)
    }));

    return {
      ...this.trace,
      server: {
        ...this.trace.server,
        ...(this.codexCliVersion === undefined ? {} : { codexCliVersion: this.codexCliVersion })
      },
      ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
      ...(this.turnId === undefined ? {} : { turnId: this.turnId }),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.model === undefined ? {} : { model: this.model }),
      completedAt: args.completedAt,
      durationMs: args.durationMs,
      status: args.status,
      reason: redactText(args.reason),
      messages,
      reasoning,
      commands,
      fileChanges
    };
  }

  public renderTranscript(): string {
    const trace = this.buildTrace({
      completedAt: new Date().toISOString(),
      durationMs: 0,
      reason: "transcript render",
      status: "blocked"
    });
    const sections: Array<[string, string]> = [
      ["Agent messages", trace.messages.map((message) => message.text).join("\n\n")],
      ["Reasoning summaries", trace.reasoning.map((entry) => entry.text).join("\n\n")],
      ["Commands", trace.commands.map((command) => `${command.command ?? "command"}\n${command.outputTail ?? ""}`).join("\n\n")],
      ["File changes", trace.fileChanges.map((fileChange) => `${fileChange.status ?? "fileChange"} ${fileChange.changeCount ?? 0} change(s)`).join("\n")]
    ];
    return sections
      .filter(([, text]) => text.trim() !== "")
      .map(([title, text]) => `## ${title}\n\n${text.trim()}`)
      .join("\n\n");
  }

  private appendText(target: Map<string, string>, message: JsonObject): void {
    const itemId = readNestedString(message, ["params", "itemId"]) ?? "unknown";
    const delta = readNestedString(message, ["params", "delta"]) ?? "";
    target.set(itemId, limitTranscript(`${target.get(itemId) ?? ""}${redactText(delta)}`));
  }

  private recordItem(message: JsonObject, lifecycle: "started" | "completed"): void {
    const item = readNestedRecord(message, ["params", "item"]);
    const id = readString(item, "id") ?? `unknown-${this.trace.items.length + 1}`;
    const type = readString(item, "type") ?? "unknown";
    const status = readString(item, "status");
    this.trace.items.push({
      id,
      type,
      lifecycle,
      title: itemTitle(item, type),
      ...(status === undefined ? {} : { status })
    });
    if (lifecycle === "started") {
      this.trace.counts.itemStarts += 1;
    } else {
      this.trace.counts.itemCompletions += 1;
    }
    if (type === "commandExecution") {
      this.recordCommand(item, id, status);
    }
    if (type === "fileChange") {
      this.recordFileChange(item, id, status);
    }
    if (type === "mcpToolCall" || type === "dynamicToolCall") {
      this.recordToolCall(item, id, type, status);
    }
  }

  private recordCommand(item: JsonObject, itemId: string, status: string | undefined): void {
    const existingIndex = this.trace.commands.findIndex((command) => command.itemId === itemId);
    const commandCwd = readString(item, "cwd");
    const command = {
      itemId,
      ...(readString(item, "command") === undefined ? {} : { command: redactText(readString(item, "command") ?? "") }),
      ...(commandCwd === undefined ? {} : { cwd: publicPathForTrace(commandCwd, this.rootCwd) }),
      ...(status === undefined ? {} : { status }),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      ...(readString(item, "aggregatedOutput") === undefined ? {} : { outputTail: tailText(redactText(readString(item, "aggregatedOutput") ?? ""), 2_000) })
    } satisfies CodexTraceCommand;
    if (existingIndex === -1) {
      this.trace.commands.push(command);
    } else {
      this.trace.commands[existingIndex] = { ...this.trace.commands[existingIndex], ...command };
    }
  }

  private recordFileChange(item: JsonObject, itemId: string, status: string | undefined): void {
    this.trace.counts.fileChanges += 1;
    const existingIndex = this.trace.fileChanges.findIndex((fileChange) => fileChange.itemId === itemId);
    const fileChange = {
      itemId,
      ...(status === undefined ? {} : { status }),
      ...(Array.isArray(item.changes) ? { changeCount: item.changes.length } : {})
    } satisfies CodexTraceFileChange;
    if (existingIndex === -1) {
      this.trace.fileChanges.push(fileChange);
    } else {
      this.trace.fileChanges[existingIndex] = { ...this.trace.fileChanges[existingIndex], ...fileChange };
    }
  }

  private recordToolCall(item: JsonObject, itemId: string, type: string, status: string | undefined): void {
    this.trace.counts.tools += 1;
    const server = readString(item, "server");
    const tool = readString(item, "tool");
    this.trace.tools.push({
      itemId,
      kind: type === "mcpToolCall" ? "mcp" : type === "dynamicToolCall" ? "dynamic" : "unknown",
      ...(server === undefined ? {} : { server }),
      ...(tool === undefined ? {} : { tool }),
      ...(status === undefined ? {} : { status })
    });
  }

  private recordPlan(message: JsonObject): void {
    const params = isRecord(message.params) ? message.params : {};
    const explanation = typeof params.explanation === "string" ? params.explanation : undefined;
    const plan = Array.isArray(params.plan) ? params.plan : [];
    this.trace.plans.push({
      ...(explanation === undefined ? {} : { explanation: redactText(explanation) }),
      steps: plan.map((step) => summarizePlanStep(step))
    });
  }
}

function readNestedRecord(value: unknown, pathParts: string[]): JsonObject {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return {};
    }
    current = current[part];
  }
  return isRecord(current) ? current : {};
}

function readNestedString(value: unknown, pathParts: string[]): string | undefined {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

function readString(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function itemTitle(item: JsonObject, type: string): string {
  if (type === "commandExecution") {
    return redactText(readString(item, "command") ?? "command execution");
  }
  if (type === "agentMessage") {
    return tailText(redactText(readString(item, "text") ?? "agent message"), 120);
  }
  if (type === "mcpToolCall") {
    return redactText([readString(item, "server"), readString(item, "tool")].filter(Boolean).join("/") || "mcp tool call");
  }
  if (type === "dynamicToolCall") {
    return redactText(readString(item, "tool") ?? "dynamic tool call");
  }
  return redactText(type);
}

function summarizePlanStep(step: unknown): string {
  if (!isRecord(step)) {
    return redactText(String(step));
  }
  const text = readString(step, "step") ?? readString(step, "text") ?? readString(step, "description") ?? JSON.stringify(redactJsonValue(step));
  const status = readString(step, "status");
  return status ? `${status}: ${redactText(text)}` : redactText(text);
}

function formatJsonRpcError(error: JsonObject): string {
  const code = typeof error.code === "number" ? `${error.code}: ` : "";
  const message = typeof error.message === "string" ? error.message : JSON.stringify(redactJsonValue(error));
  return redactText(`${code}${message}`);
}

function redactCodexEnvelope(value: unknown, rootCwd: string): unknown {
  const redacted = redactJsonValue(value, "", rootCwd);
  if (!isRecord(value) || !isRecord(redacted) || value.method !== "turn/start") {
    return redacted;
  }

  const rawParams = isRecord(value.params) ? value.params : {};
  const redactedParams = isRecord(redacted.params) ? redacted.params : {};
  const rawInput = Array.isArray(rawParams.input) ? rawParams.input : null;
  const redactedInput = Array.isArray(redactedParams.input) ? redactedParams.input : null;
  if (!rawInput || !redactedInput) {
    return redacted;
  }

  return {
    ...redacted,
    params: {
      ...redactedParams,
      input: redactedInput.map((entry, index) => redactTurnInputEntry(rawInput[index], entry))
    }
  };
}

function redactTurnInputEntry(rawEntry: unknown, redactedEntry: unknown): unknown {
  if (!isRecord(redactedEntry)) {
    return redactedEntry;
  }

  const rawText = isRecord(rawEntry) && typeof rawEntry.text === "string" ? rawEntry.text : undefined;
  if (rawText === undefined) {
    return redactedEntry;
  }

  return {
    ...redactedEntry,
    text: "[REDACTED_PROMPT_TEXT]",
    textDigest: digestText(rawText),
    textLength: rawText.length,
    ...(Array.isArray(redactedEntry.text_elements) ? { text_elements: [] } : {})
  };
}

function redactJsonValue(value: unknown, keyHint = "", rootCwd?: string): unknown {
  if (typeof value === "string") {
    if (authLikeKey.test(keyHint)) {
      return "[REDACTED_SECRET]";
    }
    if (rootCwd && pathLikeKey.test(keyHint)) {
      return publicPathForTrace(value, rootCwd);
    }
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, keyHint, rootCwd));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactJsonValue(entry, key, rootCwd)])
    );
  }
  return value;
}

function limitTranscript(value: string): string {
  const maxChars = 80_000;
  if (value.length <= maxChars) {
    return value;
  }
  return `[...sanitized transcript truncated to last ${maxChars} characters...]\n${value.slice(-maxChars)}`;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
