// One restricted Codex request's turn: the notifications and tool requests the app-server sends
// while the turn runs. Each is checked against the tool policy, the turn's identity and the output
// limits, and any violation stops the request's deadline with a refusal code.
import {
  CODEX_MAX_OUTPUT_BYTES,
  CODEX_MAX_REQUEST_BYTES,
  codexRecord,
  restrictedCodexUsage,
  toolPolicyViolation,
  type RestrictedCodexResult,
  type RestrictedCodexUsage,
} from "./restricted-policy.js";
import {
  RestrictedCodexStop,
  type RestrictedCodexDeadline,
  type RestrictedCodexTransport,
} from "./restricted-transport.js";

const rawCompactionTypes = ["compaction", "compaction_summary", "context_compaction"];
const analystRawItemTypes = ["message", "reasoning", ...rawCompactionTypes];
const participantRawItemTypes = [
  ...analystRawItemTypes,
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
];

type Event = { method: string; params: Record<string, unknown> };

function hasScopedIdentity(
  method: string,
  params: Record<string, unknown>,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  if (method === "turn/started" || method === "turn/completed") {
    const id = codexRecord(params.turn).id;
    return (
      params.threadId === threadId &&
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= 200 &&
      (turnId === undefined || id === turnId)
    );
  }
  if (
    method.startsWith("item/") ||
    method.startsWith("rawResponse") ||
    method === "thread/tokenUsage/updated"
  )
    return (
      params.threadId === threadId &&
      typeof params.turnId === "string" &&
      params.turnId.length > 0 &&
      (turnId === undefined || params.turnId === turnId)
    );
  return (
    (params.threadId === undefined || params.threadId === threadId) &&
    (params.turnId === undefined || params.turnId === turnId)
  );
}

function usageDelta(
  total: RestrictedCodexUsage,
  baseline: RestrictedCodexUsage,
): RestrictedCodexUsage | null {
  const delta = {
    input: total.input - baseline.input,
    output: total.output - baseline.output,
    cachedInput: (total.cachedInput ?? 0) - (baseline.cachedInput ?? 0),
    cacheWriteInput: (total.cacheWriteInput ?? 0) - (baseline.cacheWriteInput ?? 0),
  };
  return Object.values(delta).every((value) => Number.isSafeInteger(value) && value >= 0) &&
    delta.cachedInput + delta.cacheWriteInput <= delta.input
    ? delta
    : null;
}

/** What a turn reads from and reports to its session. */
export interface RestrictedCodexTurnContext {
  readonly deadline: RestrictedCodexDeadline;
  /** The session's thread, read when each event arrives. */
  threadId(): string | undefined;
  /** A participant session has one dynamic tool; an analyst has none. */
  readonly participant: boolean;
  /**
   * The participant's tool, read at each use as the session's options hold it then, so a tool
   * the host replaced mid-request is the one checked and called. Only read when participant.
   */
  tool(): { name: string; call(args: unknown): Promise<string> };
  /** Thread usage when the request began; null once an earlier turn's usage was unknown. */
  readonly usageBaseline: RestrictedCodexUsage | null;
  /** Tool call ids already answered in this session. */
  readonly toolCallIds: Set<string>;
  /** This turn's usage so far, for the session's pending-usage getters. */
  reportUsage(
    usage: RestrictedCodexUsage | undefined,
    inference: RestrictedCodexUsage[] | undefined,
  ): void;
  /** The turn the session interrupts if it closes now. */
  turnStarted(turnId: string): void;
}

/**
 * Drain: every notification and tool request of one turn. Nothing is handled before `dispatched`;
 * events that arrive before turn/start's reply wait until acknowledge() and are then checked in
 * order. `finished` resolves only with a completed, validated final answer.
 */
export class RestrictedCodexTurn {
  dispatched = false;
  usage: RestrictedCodexUsage | null = null;
  latestUsage: RestrictedCodexUsage | null = null;
  inferenceUsage: RestrictedCodexUsage[] | null;
  readonly finished: Promise<RestrictedCodexResult>;
  private turnId: string | undefined;
  private earlyTurnId: string | undefined;
  private completed = false;
  private compacted = false;
  private toolRequestPending = false;
  private generatedDeltaBytes = 0;
  private outputItem: { id: string; text: string } | undefined;
  private readonly early: Event[] = [];
  private readonly allowedRawItemTypes: readonly string[];
  private resolveFinished!: (value: RestrictedCodexResult) => void;
  private resolveTurnReady!: (value: string) => void;
  private readonly turnReady: Promise<string>;

  constructor(private readonly context: RestrictedCodexTurnContext) {
    this.inferenceUsage = context.participant ? [] : null;
    this.allowedRawItemTypes = context.participant ? participantRawItemTypes : analystRawItemTypes;
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    this.turnReady = new Promise((resolve) => {
      this.resolveTurnReady = resolve;
    });
  }

  /** turn/start's reply: records the turn id, then checks the events that arrived before it. */
  acknowledge(returnedTurnId: unknown): void {
    if (
      typeof returnedTurnId !== "string" ||
      returnedTurnId.length === 0 ||
      returnedTurnId.length > 200 ||
      (this.earlyTurnId !== undefined && this.earlyTurnId !== returnedTurnId)
    )
      throw new RestrictedCodexStop("codex_protocol_error");
    this.turnId = returnedTurnId;
    this.resolveTurnReady(returnedTurnId);
    this.context.turnStarted(returnedTurnId);
    for (const event of this.early) this.handleTurnEvent(event.method, event.params);
    this.early.length = 0;
  }

  readonly onNotification: RestrictedCodexTransport["onNotification"] = (method, params) => {
    const { deadline } = this.context;
    if (!this.dispatched) return;
    if (
      !hasScopedIdentity(method, params, this.context.threadId(), this.turnId ?? this.earlyTurnId)
    ) {
      deadline.stop("codex_protocol_error");
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (typeof params.delta !== "string") {
        deadline.stop("codex_protocol_error");
        return;
      }
      this.generatedDeltaBytes += Buffer.byteLength(params.delta);
      if (this.generatedDeltaBytes > CODEX_MAX_OUTPUT_BYTES) {
        deadline.stop("response_too_large");
        return;
      }
    }
    // The single tool-policy check. Tool requests must fail even if the turn-start
    // acknowledgment is lost, and every event reaches handleTurnEvent only from here, directly
    // or through the early buffer, so no event skips it.
    if (toolPolicyViolation(method, codexRecord(params.item), this.allowedRawItemTypes)) {
      deadline.stop("codex_tool_call");
      return;
    }
    if (method === "turn/started") {
      const value = codexRecord(params.turn).id;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        (this.earlyTurnId !== undefined && value !== this.earlyTurnId)
      )
        deadline.stop("codex_protocol_error");
      else {
        this.earlyTurnId = value;
        this.context.turnStarted(value);
      }
    }
    if (this.turnId === undefined) this.early.push({ method, params });
    else this.handleTurnEvent(method, params);
  };

  readonly onRequest: NonNullable<RestrictedCodexTransport["onRequest"]> = async (
    method,
    params,
  ) => {
    const { deadline, participant, toolCallIds } = this.context;
    const callId = params.callId;
    if (
      !participant ||
      method !== "item/tool/call" ||
      params.threadId !== this.context.threadId() ||
      typeof params.turnId !== "string" ||
      params.turnId.length === 0 ||
      params.turnId.length > 200 ||
      params.namespace !== null ||
      params.tool !== this.context.tool().name ||
      typeof callId !== "string" ||
      callId.length === 0 ||
      callId.length > 200 ||
      toolCallIds.has(callId) ||
      this.toolRequestPending
    )
      throw new RestrictedCodexStop("codex_tool_call");
    // Mark the request outstanding before waiting for a same-chunk turn/start
    // acknowledgment, so an early completion can never be accepted.
    this.toolRequestPending = true;
    const activeTurnId = this.turnId ?? this.earlyTurnId ?? (await deadline.wait(this.turnReady));
    if (params.turnId !== activeTurnId) throw new RestrictedCodexStop("codex_tool_call");
    toolCallIds.add(callId);
    deadline.pause();
    const text = await deadline.wait(this.context.tool().call(params.arguments));
    if (typeof text !== "string" || Buffer.byteLength(text) > CODEX_MAX_REQUEST_BYTES)
      throw new RestrictedCodexStop("invalid_response");
    try {
      JSON.parse(text);
    } catch {
      throw new RestrictedCodexStop("invalid_response");
    }
    return { success: true, contentItems: [{ type: "inputText", text }] };
  };

  readonly onRequestComplete = (): void => {
    this.toolRequestPending = false;
  };

  private handleTurnEvent(method: string, params: Record<string, unknown>): void {
    const { deadline } = this.context;
    if (!hasScopedIdentity(method, params, this.context.threadId(), this.turnId)) {
      deadline.stop("codex_protocol_error");
      return;
    }
    const item = codexRecord(params.item);
    // CLI 0.154.0 thread totals omitted compaction requests; later releases were not re-measured.
    // Retain known usage, but never label it complete when native compaction occurred.
    if (
      method === "thread/compacted" ||
      item.type === "contextCompaction" ||
      rawCompactionTypes.includes(String(item.type))
    )
      this.compacted = true;
    // onNotification already applied toolPolicyViolation to this event.
    if (
      method === "rawResponseItem/completed" &&
      item.type === "message" &&
      Array.isArray(item.content) &&
      item.content.some((content) => codexRecord(content).type === "refusal")
    )
      deadline.stop("refusal");
    if (method === "thread/tokenUsage/updated") this.recordUsage(params);
    if (
      (method === "item/started" || method === "item/completed") &&
      !this.admitsItem(method, item)
    )
      return;
    if (method === "turn/completed") this.complete(codexRecord(params.turn));
  }

  private recordUsage(params: Record<string, unknown>): void {
    const baseline = this.context.usageBaseline;
    const total = restrictedCodexUsage(params.tokenUsage);
    // App-server reports cumulative thread usage. Receipts must charge only this turn.
    this.usage = total && baseline ? usageDelta(total, baseline) : null;
    if (this.inferenceUsage !== null) {
      const inferenceDelta =
        total && (this.latestUsage ?? baseline)
          ? usageDelta(total, (this.latestUsage ?? baseline)!)
          : null;
      if (!inferenceDelta) this.inferenceUsage = null;
      else if (Object.values(inferenceDelta).some((value) => value > 0))
        this.inferenceUsage.push(inferenceDelta);
    }
    this.context.reportUsage(
      this.usage ?? undefined,
      this.inferenceUsage?.length ? this.inferenceUsage.map((item) => ({ ...item })) : undefined,
    );
    this.latestUsage = total;
  }

  /** The item allowlist, the participant's one dynamic tool and the final answer's shape. */
  private admitsItem(method: string, item: Record<string, unknown>): boolean {
    const { deadline, participant } = this.context;
    const allowedItems = participant
      ? ["userMessage", "agentMessage", "reasoning", "contextCompaction", "dynamicToolCall"]
      : ["userMessage", "agentMessage", "reasoning", "contextCompaction"];
    if (!allowedItems.includes(String(item.type))) {
      deadline.stop("codex_tool_call");
      return false;
    }
    if (
      item.type === "dynamicToolCall" &&
      (item.tool !== (participant ? this.context.tool().name : undefined) ||
        item.namespace !== null ||
        (method === "item/started" && item.status !== "inProgress") ||
        (method === "item/completed" && (item.status !== "completed" || item.success !== true)))
    ) {
      deadline.stop("codex_tool_call");
      return false;
    }
    if (
      item.type === "agentMessage" &&
      method === "item/completed" &&
      item.phase !== "commentary"
    ) {
      if (
        typeof item.id !== "string" ||
        typeof item.text !== "string" ||
        Buffer.byteLength(item.text) > CODEX_MAX_OUTPUT_BYTES ||
        (item.phase !== null && item.phase !== "final_answer") ||
        (item.delivery !== null && item.delivery !== undefined) ||
        (this.outputItem && (this.outputItem.id !== item.id || this.outputItem.text !== item.text))
      ) {
        deadline.stop("invalid_response");
        return false;
      }
      this.outputItem = { id: item.id, text: item.text };
    }
    return true;
  }

  private complete(turn: Record<string, unknown>): void {
    const { deadline } = this.context;
    if (turn.id !== this.turnId || this.completed || this.toolRequestPending) {
      deadline.stop("codex_protocol_error");
      return;
    }
    this.completed = true;
    if (turn.status === "interrupted") {
      deadline.stop("cancelled");
      return;
    }
    if (turn.status !== "completed" || turn.error !== null || !this.outputItem) {
      deadline.stop("invalid_response");
      return;
    }
    try {
      this.context.reportUsage(undefined, undefined);
      this.resolveFinished({
        status: "completed",
        output: JSON.parse(this.outputItem.text) as unknown,
        usage: this.usage,
        usageComplete: this.usage !== null && !this.compacted,
        dispatched: true,
        errorCode: null,
      });
    } catch {
      deadline.stop("invalid_response");
    }
  }
}
