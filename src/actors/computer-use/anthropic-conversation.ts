import type { ActorConversation } from "../contract.js";
import {
  HALT_TEXT,
  message,
  parseMessage,
  pointerAfter,
  requestBody,
  screenImage,
  toolResult,
  type MemberCall,
  type MessagesSettings,
  type ParsedMessage,
  type Point,
} from "./anthropic-wire.js";
import {
  closingAccount,
  closingSchema,
  replyFormText,
  type ClosingRequest,
} from "./closing-account.js";
import type { CuaActionAcknowledgement, CuaTurn, CuaTurnRequest } from "./loop/types.js";
import { screenSize, zoomView } from "./zoom-view.js";

// The conversation the Anthropic computer-use provider has with the model. The Messages API keeps
// no conversation, so every request carries all of it, and Claude Haiku 5.5 invalidates a
// thinking block when anything sent before it changes. The history is therefore append-only:
// the system prompt is the study instructions, fixed by the first request; the toolset is one
// constant; each reply is appended verbatim; and every later request adds only new messages.
// The one cut is at a server-side compaction (anthropic-wire.ts): a reply that starts with a
// compaction summary replaces everything before it, which the server no longer reads and the
// thinking check no longer covers, so the history restarts at that reply.

/** One request of the conversation, built once, so a retry sends the same body. */
export interface ConversationRequest {
  readonly body: Record<string, unknown>;
  /** The body as JSON, the bytes the request sends. */
  readonly payload: string;
  /** Move the conversation on to the request's reply and return the reply's turn. */
  accept(reply: unknown): CuaTurn;
}

/** The text before a screenshot sent outside a tool_result, so the model reads it as the screen. */
const SCREEN_NOW = "This is the screen now.";

/** How a member call that ran answers when its result carries no screenshot. */
const OK = "OK";

/**
 * A screenshot call before the end of its batch whose desktop returned no frame: the screen then
 * comes once, after the batch.
 */
const SCREEN_AT_END = "The screen after this turn's last action is in its last result.";

export class AnthropicConversation {
  /**
   * Every message sent and received since the latest compaction, in order. Only ever appended
   * to, apart from the cut a compaction makes.
   */
  private readonly history: unknown[] = [];
  private instructions: string | undefined;
  /** The latest accepted reply: the next request answers each of its member calls. */
  private latest: ParsedMessage | undefined;
  /** The pointer's position after the last action the desktop acknowledged completing. */
  private pointer: Point | undefined;
  /** The messages of a closing request whose reply was not the stated JSON, for its retry. */
  private openClosing: readonly unknown[] | undefined;
  /** Accepted replies the history holds, each carried in every later request. */
  private replies = 0;
  /** Accepted replies a compaction summarized, which no later request carries. */
  private summarized = 0;
  private readonly requests: ActorConversation["requests"] = [];
  /** Why replies' usage could not be priced, each told to the trace once. */
  private readonly unpricedReasons = new Set<string>();

  constructor(private readonly settings: MessagesSettings) {}

  /** The next participant turn's request, carrying `req`'s screen and acknowledgements. */
  request(req: CuaTurnRequest): ConversationRequest {
    const sent = this.newMessages(req);
    const pointer = this.pointerAfterBatch(req);
    const body = requestBody(this.settings, this.fixInstructions(req.instructions), [
      ...this.history,
      ...sent,
    ]);
    const payload = JSON.stringify(body);
    return {
      body,
      payload,
      accept: (reply) => {
        const parsed = parseMessage(reply, pointer, outputLimit(body));
        this.recordRequest(sent, parsed, payload);
        // A reply that ended without a decision (output limit, refusal, an unexpected stop) is
        // set aside, so asking again sends this same request.
        if (parsed.turn.interruption === undefined) this.moveOn(sent, parsed, pointer);
        return this.withPricingNotice(parsed);
      },
    };
  }

  /**
   * The read-only closing request carrying `req`'s screen, sent once as JSON with `send`. It
   * answers the latest reply's calls, then asks for the closing account with its JSON Schema
   * stated in text, since an output format would miss the cached prefix. A completed reply that
   * is not JSON the schema accepts comes back marked closingRetry and leaves the conversation
   * where it was; the next closing request sends the same messages with the schema set as the
   * output format.
   */
  async close(
    req: CuaTurnRequest,
    closing: ClosingRequest,
    send: (payload: string) => Promise<unknown>,
  ): Promise<CuaTurn> {
    const strict = this.openClosing !== undefined;
    const sent = this.openClosing ?? this.newMessages(req, closing);
    this.openClosing = undefined;
    const pointer = this.pointerAfterBatch(req);
    const body = requestBody(
      this.settings,
      this.fixInstructions(req.instructions),
      [...this.history, ...sent],
      strict ? { schema: closingSchema(closing) } : {},
    );
    const payload = JSON.stringify(body);
    const reply = await send(payload);
    const parsed = parseMessage(reply, pointer, outputLimit(body));
    if (closing === "impressions") this.recordRequest(sent, parsed, payload, "impressions");
    const completed = parsed.stopReason === "end_turn";
    const account = completed ? closingAccount(parsed.turn.message, closing, strict) : undefined;
    if (completed && account === undefined && !strict) {
      this.openClosing = sent;
      return { ...this.withPricingNotice(parsed), closingRetry: true };
    }
    this.moveOn(sent, parsed, pointer);
    return { ...this.withPricingNotice(parsed), ...account };
  }

  /**
   * Whether a reply's usage could not be priced from the rate table. Once one could not, the
   * session's estimate may be low, which the provider reports as incomplete usage.
   */
  get usageUnpriced(): boolean {
    return this.unpricedReasons.size > 0;
  }

  /** The trace's account of how the conversation was carried (ActorConversation). */
  record(): ActorConversation {
    return {
      mode: "explicit_context",
      explicitReason: "stateless_api",
      summarizedTurns: this.summarized,
      requests: this.requests.map((request) => ({ ...request })),
    };
  }

  /** The study instructions, which the first request fixes as the system prompt. */
  private fixInstructions(instructions: string): string {
    this.instructions ??= instructions;
    if (instructions !== this.instructions) {
      throw new Error(
        "The Anthropic provider sends one system prompt per session; a later request carried different instructions.",
      );
    }
    return instructions;
  }

  /**
   * The messages a request adds: the user message that answers the latest reply's calls with the
   * screen (or the screen alone), then the turn's harness guidance as a system message. A closing
   * request asks for its account in the user message instead.
   */
  private newMessages(req: CuaTurnRequest, closing?: ClosingRequest): unknown[] {
    const frame = req.observation.screenshot;
    const screen = screenImage(frame);
    const calls = this.latest?.calls ?? [];
    const answered =
      calls.length === 0
        ? [{ type: "text", text: SCREEN_NOW }, screen]
        : answers(calls, acknowledgements(req), screen, screenSize(frame));
    const hint = req.contextHint === undefined || req.contextHint === "" ? [] : [req.contextHint];
    if (closing !== undefined) {
      const ask = [...hint, replyFormText(closing)].map((text) => ({ type: "text", text }));
      return [message("user", [...answered, ...ask])];
    }
    return [message("user", answered), ...hint.map((text) => message("system", text))];
  }

  /**
   * Where the pointer is once the latest batch ran: moved by each action the desktop acknowledged
   * completing, unknown after one that failed or whose outcome is uncertain, and unchanged by one
   * that was never sent.
   */
  private pointerAfterBatch(req: CuaTurnRequest): Point | undefined {
    const actions = this.latest?.turn.actions ?? [];
    if (actions.length === 0) return this.pointer;
    const acks = acknowledgements(req);
    let pointer = this.pointer;
    for (const [index, action] of actions.entries()) {
      const ack = acks.get(index);
      if (ack === undefined || ack.status === "not_dispatched") continue;
      if (ack.status !== "completed") {
        pointer = undefined;
        continue;
      }
      const read =
        ack.result?.kind === "pointer" ? { x: ack.result.x, y: ack.result.y } : undefined;
      pointer = pointerAfter(action) ?? read ?? pointer;
    }
    return pointer;
  }

  /** The reply's turn, with a notice the first time a reason its usage is unpriced appears. */
  private withPricingNotice(parsed: ParsedMessage): CuaTurn {
    const reason = parsed.unpricedUsage;
    if (reason === undefined || this.unpricedReasons.has(reason)) return parsed.turn;
    this.unpricedReasons.add(reason);
    const text = `${reason} Its tokens are counted at the standard rates, so the cost estimate may be low, and a session with a spend cap stops before its next request.`;
    return {
      ...parsed.turn,
      notices: [
        ...(parsed.turn.notices ?? []),
        { title: "participant usage outside the rate table", text },
      ],
    };
  }

  private moveOn(sent: readonly unknown[], parsed: ParsedMessage, pointer: Point | undefined) {
    if (parsed.compacted) {
      this.summarized += this.replies;
      this.replies = 0;
      this.history.length = 0;
    } else this.history.push(...sent);
    this.history.push(message("assistant", parsed.content));
    this.latest = parsed;
    this.pointer = pointer;
    this.replies += 1;
  }

  private recordRequest(
    sent: readonly unknown[],
    parsed: ParsedMessage,
    payload: string,
    kind?: "impressions",
  ) {
    this.requests.push({
      mode: "explicit_context",
      ...(kind === undefined ? {} : { kind }),
      carriedExchanges: this.replies,
      carriedScreenshots: countImages([...this.history, ...sent]),
      requestBytes: Buffer.byteLength(payload),
      // A reply set aside is asked again uncompacted, so its summary replaced nothing.
      ...(parsed.compacted && parsed.turn.interruption === undefined
        ? { compacted: true as const }
        : {}),
    });
  }
}

/** A request body's max_tokens, which also bounds a compaction it runs. */
function outputLimit(body: Record<string, unknown>): number | undefined {
  return typeof body.max_tokens === "number" ? body.max_tokens : undefined;
}

type Acknowledgements = ReadonlyMap<number, CuaActionAcknowledgement>;

function acknowledgements(req: CuaTurnRequest): Acknowledgements {
  return new Map((req.previousExecution?.actions ?? []).map((ack) => [ack.index, ack]));
}

/** What a call that did not complete tells the model, by its first unfinished action's status. */
const NOT_COMPLETED: Readonly<
  Record<Exclude<CuaActionAcknowledgement["status"], "completed">, string>
> = {
  skipped: "The desktop command failed.",
  outcome_uncertain: "The desktop did not confirm this action; check the screen.",
  not_dispatched: "Not executed: this action was not sent to the desktop.",
};

/**
 * One tool_result per call, in order. A call answers OK when every action it ran completed, and
 * a read answers with what it read: `cursor_position` the pointer's coordinates, `zoom` its
 * image, and a `screenshot` before the last call the screen the desktop captured there. The first
 * call that did not complete answers why, and every later one the halt text, as the toolset
 * documents for a batch that stops at its first failure. A read that completed but returned
 * nothing answers as an error without halting the batch, whose later actions ran. The screen
 * after the batch goes into the last result when that one completed and holds no image of its
 * own; an error result may carry text only, so otherwise the screen follows the results.
 */
function answers(
  calls: readonly MemberCall[],
  acks: Acknowledgements,
  screen: Record<string, unknown>,
  fit: { width: number; height: number } | undefined,
): unknown[] {
  let halted = false;
  let screenInLast = false;
  const results = calls.map((call, index) => {
    if (halted) return toolResult(call, HALT_TEXT, { isError: true });
    const done = call.positions.map((position) => acks.get(position));
    const unfinished = done.find((ack) => ack?.status !== "completed");
    if (call.rejected !== undefined || unfinished !== undefined) {
      halted = true;
      const reason = call.rejected ?? NOT_COMPLETED[unfinishedStatus(unfinished)];
      return toolResult(call, reason, { isError: true });
    }
    const read = readAnswer(call, done[0], fit);
    if (read !== undefined) return read;
    const last = index === calls.length - 1;
    screenInLast = last;
    if (last) return toolResult(call, OK, { screen });
    return call.name === "screenshot" ? screenshotAnswer(call, done[0]) : toolResult(call, OK);
  });
  return screenInLast ? results : [...results, { type: "text", text: SCREEN_NOW }, screen];
}

/**
 * A screenshot before the last call: the screen the desktop captured at that point of the batch,
 * through the same size check as every screen sent. An executor that returned no frame leaves the
 * call pointing to the screen after the batch.
 */
function screenshotAnswer(
  call: MemberCall,
  ack: CuaActionAcknowledgement | undefined,
): Record<string, unknown> {
  const result = ack?.result;
  if (result?.kind !== "frame") return toolResult(call, SCREEN_AT_END);
  try {
    return toolResult(call, OK, { screen: screenImage(result.screenshot) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The screenshot could not be sent.";
    return toolResult(call, reason, { isError: true });
  }
}

function unfinishedStatus(
  ack: CuaActionAcknowledgement | undefined,
): Exclude<CuaActionAcknowledgement["status"], "completed"> {
  return ack === undefined || ack.status === "completed" ? "not_dispatched" : ack.status;
}

/**
 * The result of a completed read: `cursor_position` as `X=…, Y=…` in screenshot pixels, `zoom`
 * as its image enlarged to fit the screenshot size (`fit`) as the toolset documents, or an
 * error when the desktop returned nothing. Undefined for any other call. The enlarged image goes
 * through the same size check as a screenshot, so its larger visual-token count is checked before
 * the request is sent.
 */
function readAnswer(
  call: MemberCall,
  ack: CuaActionAcknowledgement | undefined,
  fit: { width: number; height: number } | undefined,
): Record<string, unknown> | undefined {
  const result = ack?.result;
  if (call.name === "cursor_position") {
    return result?.kind === "pointer"
      ? toolResult(call, `X=${result.x}, Y=${result.y}`)
      : toolResult(call, "The desktop returned no pointer position.", { isError: true });
  }
  if (call.name !== "zoom") return undefined;
  if (result?.kind !== "frame")
    return toolResult(call, "The desktop returned no image for this zoom.", { isError: true });
  try {
    return toolResult(call, OK, { screen: screenImage(zoomView(result.screenshot, fit)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The zoomed image could not be sent.";
    return toolResult(call, reason, { isError: true });
  }
}

function countImages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, entry) => n + countImages(entry), 0);
  if (typeof value !== "object" || value === null) return 0;
  const record = value as Record<string, unknown>;
  if (record.type === "image") return 1;
  return countImages(record.content);
}
