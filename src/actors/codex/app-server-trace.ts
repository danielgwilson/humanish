// The trace a codex-app-server run writes (summary.json): its schema, the recorder that builds it
// from app-server envelopes, and the redaction applied before anything is persisted.
import { digestText, publicPathForTrace, redactText, tailText } from "../../evidence/redaction.js";

export const CODEX_APP_SERVER_TRACE_SCHEMA = "humanish.codex-app-server-trace.v1";

export type JsonObject = Record<string, unknown>;
export type JsonRpcId = number | string;

export type CodexAppServerStatus = "passed" | "failed" | "blocked" | "timed_out";

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

interface CodexTraceItem {
  id: string;
  type: string;
  status?: string;
  lifecycle: "started" | "completed";
  title: string;
}

interface CodexTraceText {
  itemId: string;
  text: string;
}

interface CodexTracePlan {
  explanation?: string;
  steps: string[];
}

interface CodexTraceCommand {
  itemId: string;
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
  outputTail?: string;
}

interface CodexTraceFileChange {
  itemId: string;
  status?: string;
  changeCount?: number;
  outputTail?: string;
}

interface CodexTraceToolCall {
  itemId: string;
  kind: "mcp" | "dynamic" | "unknown";
  server?: string;
  tool?: string;
  status?: string;
}

interface CodexTraceApproval {
  id: JsonRpcId;
  method: string;
  itemId?: string;
  decision: "decline" | "denied" | "empty";
  reason: string;
}

interface CodexTraceNotice {
  method: string;
  message: string;
}

const authLikeKey =
  /(api[_-]?key|access[_-]?token|auth[_-]?url|authorization|bearer|credential|password|secret|token)$/i;
const pathLikeKey = /^(cwd|path|writableRoots|workspaceRoot)$/i;

export class CodexTraceRecorder {
  private readonly commandOutputs = new Map<string, string>();
  private readonly fileOutputs = new Map<string, string>();
  private readonly messageDeltas = new Map<string, string>();
  private readonly reasoningDeltas = new Map<string, string>();
  private readonly rootCwd: string;
  private readonly trace: Omit<
    CodexAppServerTrace,
    "completedAt" | "durationMs" | "reason" | "status"
  >;

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
        notes:
          "Trace envelopes and text were redacted before persistence. App-server schemas are version-specific and are not embedded in this run artifact.",
      },
      client: {
        name: "humanish_cli",
        title: "Humanish CLI",
        experimentalApi: args.experimentalApi,
      },
      server: {
        commandName: args.commandName,
        transport: "stdio",
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
        warnings: 0,
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
      errors: [],
    };
  }

  public observeEnvelope(direction: "client" | "server", message: unknown): void {
    this.trace.counts.envelopes += 1;
    if (direction === "client") {
      this.trace.counts.requests += isRecord(message) && "id" in message ? 1 : 0;
    } else if (isRecord(message) && "id" in message && !("method" in message)) {
      this.trace.counts.responses += 1;
    }
    const method =
      isRecord(message) && typeof message.method === "string"
        ? message.method
        : direction === "server"
          ? "response"
          : "request";
    this.trace.methods[method] = (this.trace.methods[method] ?? 0) + 1;
  }

  public observeServerMessage(message: JsonObject): void {
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "error") {
      this.addError(
        method,
        readNestedString(message, ["params", "message"]) ??
          "App-server emitted an error notification.",
      );
    }
    if (method === "warning" || method === "guardianWarning" || method === "configWarning") {
      this.addWarning(
        method,
        readNestedString(message, ["params", "message"]) ?? `App-server emitted ${method}.`,
      );
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
    if (
      method === "item/commandExecution/outputDelta" ||
      method === "command/exec/outputDelta" ||
      method === "process/outputDelta"
    ) {
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
      decision:
        typeof response.decision === "string" && response.decision === "denied"
          ? "denied"
          : typeof response.decision === "string"
            ? "decline"
            : "empty",
      reason:
        "humanish records app-server approval requests and declines by default unless a future explicit policy says otherwise.",
    });
  }

  /** Records the ids a thread/start reply or thread/started notification carries; later values win. */
  public recordThread(thread: unknown, modelFallback?: string): void {
    const record = isRecord(thread) ? thread : {};
    this.threadId = readString(record, "id") ?? this.threadId;
    this.sessionId = readString(record, "sessionId") ?? this.sessionId;
    this.model = readString(record, "model") ?? modelFallback ?? this.model;
    this.codexCliVersion = readString(record, "cliVersion") ?? this.codexCliVersion;
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
      outputTail: tailText(
        redactText(this.commandOutputs.get(command.itemId) ?? command.outputTail ?? ""),
        2_000,
      ),
    }));
    const fileChanges = this.trace.fileChanges.map((fileChange) => ({
      ...fileChange,
      outputTail: tailText(
        redactText(this.fileOutputs.get(fileChange.itemId) ?? fileChange.outputTail ?? ""),
        2_000,
      ),
    }));

    return {
      ...this.trace,
      server: {
        ...this.trace.server,
        ...(this.codexCliVersion === undefined ? {} : { codexCliVersion: this.codexCliVersion }),
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
      fileChanges,
    };
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
      ...(status === undefined ? {} : { status }),
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
      ...(readString(item, "command") === undefined
        ? {}
        : { command: redactText(readString(item, "command") ?? "") }),
      ...(commandCwd === undefined ? {} : { cwd: publicPathForTrace(commandCwd, this.rootCwd) }),
      ...(status === undefined ? {} : { status }),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      ...(readString(item, "aggregatedOutput") === undefined
        ? {}
        : { outputTail: tailText(redactText(readString(item, "aggregatedOutput") ?? ""), 2_000) }),
    } satisfies CodexTraceCommand;
    if (existingIndex === -1) {
      this.trace.commands.push(command);
    } else {
      this.trace.commands[existingIndex] = { ...this.trace.commands[existingIndex], ...command };
    }
  }

  private recordFileChange(item: JsonObject, itemId: string, status: string | undefined): void {
    this.trace.counts.fileChanges += 1;
    const existingIndex = this.trace.fileChanges.findIndex(
      (fileChange) => fileChange.itemId === itemId,
    );
    const fileChange = {
      itemId,
      ...(status === undefined ? {} : { status }),
      ...(Array.isArray(item.changes) ? { changeCount: item.changes.length } : {}),
    } satisfies CodexTraceFileChange;
    if (existingIndex === -1) {
      this.trace.fileChanges.push(fileChange);
    } else {
      this.trace.fileChanges[existingIndex] = {
        ...this.trace.fileChanges[existingIndex],
        ...fileChange,
      };
    }
  }

  private recordToolCall(
    item: JsonObject,
    itemId: string,
    type: string,
    status: string | undefined,
  ): void {
    this.trace.counts.tools += 1;
    const server = readString(item, "server");
    const tool = readString(item, "tool");
    this.trace.tools.push({
      itemId,
      kind: type === "mcpToolCall" ? "mcp" : type === "dynamicToolCall" ? "dynamic" : "unknown",
      ...(server === undefined ? {} : { server }),
      ...(tool === undefined ? {} : { tool }),
      ...(status === undefined ? {} : { status }),
    });
  }

  private recordPlan(message: JsonObject): void {
    const params = isRecord(message.params) ? message.params : {};
    const explanation = typeof params.explanation === "string" ? params.explanation : undefined;
    const plan = Array.isArray(params.plan) ? params.plan : [];
    this.trace.plans.push({
      ...(explanation === undefined ? {} : { explanation: redactText(explanation) }),
      steps: plan.map((step) => summarizePlanStep(step)),
    });
  }
}

/** The readable transcript (transcript.txt) of a built trace: messages, reasoning, commands and file changes. */
export function renderTranscript(trace: CodexAppServerTrace): string {
  const sections: Array<[string, string]> = [
    ["Agent messages", trace.messages.map((message) => message.text).join("\n\n")],
    ["Reasoning summaries", trace.reasoning.map((entry) => entry.text).join("\n\n")],
    [
      "Commands",
      trace.commands
        .map((command) => `${command.command ?? "command"}\n${command.outputTail ?? ""}`)
        .join("\n\n"),
    ],
    [
      "File changes",
      trace.fileChanges
        .map(
          (fileChange) =>
            `${fileChange.status ?? "fileChange"} ${fileChange.changeCount ?? 0} change(s)`,
        )
        .join("\n"),
    ],
  ];
  return sections
    .filter(([, text]) => text.trim() !== "")
    .map(([title, text]) => `## ${title}\n\n${text.trim()}`)
    .join("\n\n");
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

export function readNestedString(value: unknown, pathParts: string[]): string | undefined {
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
    return redactText(
      [readString(item, "server"), readString(item, "tool")].filter(Boolean).join("/") ||
        "mcp tool call",
    );
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
  const text =
    readString(step, "step") ??
    readString(step, "text") ??
    readString(step, "description") ??
    JSON.stringify(redactJsonValue(step));
  const status = readString(step, "status");
  return status ? `${status}: ${redactText(text)}` : redactText(text);
}

export function formatJsonRpcError(error: JsonObject): string {
  const code = typeof error.code === "number" ? `${error.code}: ` : "";
  const message =
    typeof error.message === "string" ? error.message : JSON.stringify(redactJsonValue(error));
  return redactText(`${code}${message}`);
}

export function redactCodexEnvelope(value: unknown, rootCwd: string): unknown {
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
      input: redactedInput.map((entry, index) => redactTurnInputEntry(rawInput[index], entry)),
    },
  };
}

function redactTurnInputEntry(rawEntry: unknown, redactedEntry: unknown): unknown {
  if (!isRecord(redactedEntry)) {
    return redactedEntry;
  }

  const rawText =
    isRecord(rawEntry) && typeof rawEntry.text === "string" ? rawEntry.text : undefined;
  if (rawText === undefined) {
    return redactedEntry;
  }

  return {
    ...redactedEntry,
    text: "[REDACTED_PROMPT_TEXT]",
    textDigest: digestText(rawText),
    textLength: rawText.length,
    ...(Array.isArray(redactedEntry.text_elements) ? { text_elements: [] } : {}),
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
      Object.entries(value).map(([key, entry]) => [key, redactJsonValue(entry, key, rootCwd)]),
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

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
