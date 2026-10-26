import type { CuaTurn, CuaTurnRequest } from "./loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import type { ActorConversation } from "../contract.js";
import { isIdleTurn } from "./loop/actions.js";
import {
  closingAccount,
  closingSchema,
  replyFormText,
  type ClosingRequest,
} from "./closing-account.js";
import { CarriedConversation, estimateTokens } from "./openai-context.js";
import {
  asArray,
  asRecord,
  buildCallOutput,
  buildContinuationRequest,
  buildFunctionOutput,
  buildInitialRequest,
  hintItems,
  inputMessage,
  openingMessage,
  parseOpenAiResponse,
  type FunctionCall,
  WAIT_TOOL_NAME,
  type OpenAiCuContext,
  type OpenAiReasoningSummary,
  type ParsedOpenAiResponse,
} from "./openai-wire.js";

// The conversation the OpenAI computer-use provider has with the model, apart from how its
// requests travel: the body of each request, how an accepted reply moves the conversation on, and
// the trace's account of how it was carried. The provider posts the bodies and retries them; it
// tells the conversation when the organization rejects server-side state or reasoning summaries.

/** How a conversation starts. The model settings stay fixed for the whole session. */
export interface OpenAiConversationSettings {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly safetyIdentifier?: string;
  /** OpenAI Fast mode for every request of the session. */
  readonly serviceTier?: "fast";
  /** The summaries to ask for until the account or model rejects them; undefined asks for none. */
  readonly reasoningSummary: OpenAiReasoningSummary | undefined;
  /** Carry the conversation on the client from the first request (explicit_context). */
  readonly zeroDataRetention: boolean;
  /** The clock the trace's record reads. */
  readonly now: () => number;
}

/**
 * One request of the conversation. Its new items are built once, so every attempt at it, and the
 * reply it accepts, see the same ones.
 */
export interface ConversationRequest {
  /** The body as the conversation stands now, so an attempt after a rejection shows its effect. */
  body(): Record<string, unknown>;
  /**
   * The request was answered: records a participant request with what it carried, moves the
   * conversation on to the reply and returns the reply's turn.
   */
  accept(reply: unknown): CuaTurn;
}

/** Which answer told the provider that the organization keeps no server-side conversation. */
export type ZdrRejection = NonNullable<ActorConversation["rejection"]>;

/**
 * The closing request's output limit: its own cap, or the declared limit when that is lower. It
 * counts reasoning too, and leaves room for six impressions after the summary and friction reports.
 */
const CLOSING_OUTPUT_LIMIT = 3072;

const CLOSING_FORMATS: Record<ClosingRequest, Record<string, unknown>> = {
  report: {
    type: "json_schema",
    name: "participant_closing_report",
    strict: true,
    schema: closingSchema("report"),
  },
  impressions: {
    type: "json_schema",
    name: "participant_impressions",
    strict: true,
    schema: closingSchema("impressions"),
  },
};

export class OpenAiConversation {
  private lastResponseId: string | undefined;
  /** computer_call ids the next request owes an output for. */
  private pendingCallIds: readonly string[] = [];
  /** The function calls the next request owes an output for. */
  private pendingFunctionCalls: readonly FunctionCall[] = [];
  /** Whether the latest reply acted, so its waits went to the desktop and were not watched. */
  private pendingActed = false;
  /** Accepted replies so far; the next request is number `replies + 1`. */
  private replies = 0;
  /** The whole conversation, which explicit-context requests carry within its token budget. */
  private readonly carried = new CarriedConversation();
  private mode: ActorConversation["mode"];
  /** Undefined once the account or model rejected reasoning summaries. */
  private reasoningSummary: OpenAiReasoningSummary | undefined;
  private readonly evidence: ConversationRecord;
  /** The items of a closing request whose reply was not the stated JSON, for its strict retry. */
  private openClosing: readonly unknown[] | undefined;

  constructor(private readonly settings: OpenAiConversationSettings) {
    this.mode = settings.zeroDataRetention ? "explicit_context" : "threaded";
    this.reasoningSummary = settings.reasoningSummary;
    this.evidence = new ConversationRecord(settings.zeroDataRetention, settings.now);
  }

  /**
   * The next participant turn's request, carrying `req`'s screen: the opening request, or the
   * outputs the latest reply's computer and function calls are owed.
   */
  request(req: CuaTurnRequest): ConversationRequest {
    const sent = this.newItems(req);
    return {
      body: () => this.turnBody(req, sent),
      accept: (reply) => this.accept(reply, sent),
    };
  }

  /**
   * The read-only closing request carrying `req`'s screen, sent once with `send`. It goes out
   * without text.format, which is part of the cached prefix, so it reads the session from the
   * cache. A completed reply that is not JSON the schema accepts comes back marked closingRetry and
   * leaves the conversation where it was, so the next closing request is the same one with the
   * strict schema set. Returns the reply's turn with the account it gave.
   */
  async close(
    req: CuaTurnRequest,
    closing: ClosingRequest,
    send: (body: Record<string, unknown>) => Promise<unknown>,
  ): Promise<CuaTurn> {
    const strict = this.openClosing !== undefined;
    // Before any accepted reply the request is the opening one, which carries no hint of its own.
    const ask = this.replies === 0 ? hintItems(req.contextHint) : [];
    const sent = this.openClosing ?? [...this.newItems(req, closing), ...ask, replyForm(closing)];
    this.openClosing = undefined;
    const reply = await send(this.closingBody(req, sent, closing, strict));
    // Recorded before the reply is accepted, as a participant turn is.
    if (closing === "impressions") this.evidence.requested(this.mode, this.carried, sent, closing);
    const completed = asRecord(reply).status === "completed";
    const parsed = this.parse(reply);
    const account = completed ? closingAccount(parsed.turn.message, closing, strict) : undefined;
    // A refusal would most likely stand under the strict schema too, so it is not asked again.
    if (completed && account === undefined && !strict && !refused(reply)) {
      this.openClosing = sent;
      return { ...parsed.turn, closingRetry: true };
    }
    this.moveOn(parsed, sent);
    return { ...parsed.turn, ...account };
  }

  /**
   * The organization rejected server-side state: carry the conversation on the client from the
   * request being sent, and record which answer made the switch. False when the conversation is
   * already carried, so the rejection stands.
   */
  switchToExplicitContext(rejection: ZdrRejection): boolean {
    if (this.mode === "explicit_context") return false;
    this.evidence.switched(rejection);
    this.mode = "explicit_context";
    return true;
  }

  /**
   * The account or model rejected reasoning summaries: stop asking for the rest of the session,
   * from the request being sent. False when none are asked for, so the rejection stands.
   */
  dropReasoningSummaries(): boolean {
    if (this.reasoningSummary === undefined) return false;
    this.reasoningSummary = undefined;
    return true;
  }

  /** The trace's account of how the conversation was carried (ActorConversation). */
  record(): ActorConversation {
    return this.evidence.snapshot(this.mode);
  }

  /**
   * The items a request adds to the conversation: the opening message with the first screen, or
   * an output for each pending call with the latest screenshot, and any hint. Each computer_call
   * output carries the screenshot. Function call outputs follow in reply order: with no
   * computer_call the first carries the screenshot, and every other one carries text only, so the
   * screenshot is sent once. A turn's hint goes into the first function call output, so it reads
   * as how the wait ended; a closing request's hint asks for the closing account and stays a user
   * message. A call to a tool that does not exist gets an output that says so (callNote).
   */
  private newItems(req: CuaTurnRequest, closing?: ClosingRequest): readonly unknown[] {
    if (this.replies === 0) return [openingMessage(req.instructions, req.observation.screenshot)];
    const { screenshot } = req.observation;
    const calls = this.pendingFunctionCalls;
    const hintInCall = closing === undefined && calls.length > 0;
    return [
      ...this.pendingCallIds.map((id) =>
        buildCallOutput(id, screenshot, req.acknowledgedSafetyChecks),
      ),
      ...calls.map((call, index) => {
        const withScreen = index === 0 && this.pendingCallIds.length === 0;
        const text = [callNote(call), index === 0 && hintInCall ? req.contextHint : undefined]
          .filter((part) => part !== undefined && part !== "")
          .join(" ");
        return withScreen
          ? buildFunctionOutput(call.callId, text, screenshot)
          : buildFunctionOutput(call.callId, text || this.waitOutcome(), null);
      }),
      ...(hintInCall ? [] : hintItems(req.contextHint)),
    ];
  }

  /**
   * What a call's output says when no note does, so every reply says how the wait went: a wait
   * among actions ran for its length (a shortened or unsent one has a note), and a further call in
   * a reply of only waits was part of the one watch the first call's output reports.
   */
  private waitOutcome(): string {
    return this.pendingActed
      ? "The wait ran for its length with your other actions."
      : "This wait was watched together with the first one in the reply.";
  }

  private context(instructions: string): OpenAiCuContext {
    const { settings } = this;
    return {
      stateless: this.mode === "explicit_context",
      model: settings.model,
      instructions,
      reasoningEffort: settings.reasoningEffort,
      ...(settings.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: settings.maxOutputTokens }),
      ...(this.reasoningSummary === undefined ? {} : { reasoningSummary: this.reasoningSummary }),
      ...(settings.safetyIdentifier === undefined
        ? {}
        : { safetyIdentifier: settings.safetyIdentifier }),
      ...(settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }),
    };
  }

  /**
   * A reply, parsed. When the session asked for a tier, the reply's usage records the tier that
   * served it, which is what the request bills at: Fast mode can fall back to `default`.
   */
  private parse(reply: unknown): ParsedOpenAiResponse {
    const parsed = parseOpenAiResponse(reply);
    const { usage } = parsed.turn;
    if (this.settings.serviceTier === undefined || usage === undefined) return parsed;
    if (parsed.serviceTier === undefined) return parsed;
    return {
      ...parsed,
      turn: { ...parsed.turn, usage: { ...usage, serviceTier: parsed.serviceTier } },
    };
  }

  /**
   * A participant request: the opening request, or a continuation carrying `sent`. A threaded
   * continuation names the previous response; an explicit-context one carries the conversation
   * ahead of `sent`.
   */
  private turnBody(req: CuaTurnRequest, sent: readonly unknown[]): Record<string, unknown> {
    const ctx = this.context(req.instructions);
    // `sent` is the opening message, and on a closing request also the ask and the reply's form.
    if (this.replies === 0)
      return { ...buildInitialRequest(ctx, req.observation.screenshot), input: [...sent] };
    return buildContinuationRequest({
      ctx,
      previousResponseId: this.lastResponseId,
      callOutputs: [...sent],
      ...(this.mode === "explicit_context" ? { explicitContextItems: this.carried.carried() } : {}),
    });
  }

  /**
   * A read-only closing request: the next turn's body with tools off and its own output limit,
   * and the strict schema only when `schema` is set.
   */
  private closingBody(
    req: CuaTurnRequest,
    sent: readonly unknown[],
    closing: ClosingRequest,
    schema: boolean,
  ): Record<string, unknown> {
    return {
      ...this.turnBody(req, sent),
      tool_choice: "none",
      max_output_tokens: Math.min(
        this.settings.maxOutputTokens ?? CLOSING_OUTPUT_LIMIT,
        CLOSING_OUTPUT_LIMIT,
      ),
      ...(schema ? { text: { format: CLOSING_FORMATS[closing] } } : {}),
    };
  }

  /**
   * A participant turn's reply to a request that added `sent`. A reply cut off by the output
   * limit is set aside, so the next request is the same one again (outputLimitRetry); its actions
   * never run, so no call output is owed for them.
   */
  private accept(reply: unknown, sent: readonly unknown[]): CuaTurn {
    // Recorded before the reply is accepted: accepting can cut the carried history, and the record
    // counts what this request carried.
    this.evidence.requested(this.mode, this.carried, sent);
    const parsed = this.parse(reply);
    if (parsed.turn.interruption === "output_limit") return parsed.turn;
    this.moveOn(parsed, sent);
    return parsed.turn;
  }

  /** Move the conversation on to a reply to a request that added `sent`. */
  private moveOn(parsed: ParsedOpenAiResponse, sent: readonly unknown[]): void {
    if (parsed.turn.responseId !== undefined) this.lastResponseId = parsed.turn.responseId;
    this.pendingCallIds = parsed.callIds;
    this.pendingFunctionCalls = parsed.functionCalls;
    this.pendingActed = !isIdleTurn(parsed.turn.actions);
    this.replies += 1;
    this.carried.accept(this.replies, sent, parsed.outputItems);
  }
}

/** What a function call's output says about the call itself: that no such tool exists. */
function callNote(call: FunctionCall): string | undefined {
  return call.name === WAIT_TOOL_NAME
    ? undefined
    : `There is no tool named ${JSON.stringify(call.name)}.`;
}

/** The closing ask's reply form as a user message (closing-account.ts). */
function replyForm(closing: ClosingRequest): unknown {
  return inputMessage("user", [{ type: "input_text", text: replyFormText(closing) }]);
}

/** Whether a reply's messages include a refusal, which carries no output_text. */
function refused(reply: unknown): boolean {
  return asArray(asRecord(reply).output).some((item) =>
    asArray(asRecord(item).content).some((part) => asRecord(part).type === "refusal"),
  );
}

/** The trace's account of how a session carried its conversation (ActorConversation). */
class ConversationRecord {
  private explicitReason: ActorConversation["explicitReason"];
  private rejection: ActorConversation["rejection"];
  private switchedAt: string | undefined;
  private switchedAtRequest: number | undefined;
  private summarizedTurns = 0;
  private readonly requests: ActorConversation["requests"] = [];

  constructor(
    configured: boolean,
    private readonly now: () => number,
  ) {
    if (configured) this.explicitReason = "configured";
  }

  /** The organization rejected server-side state, so the request being sent is explicit_context. */
  switched(rejection: ZdrRejection): void {
    this.explicitReason = "zdr_rejection";
    this.rejection = rejection;
    this.switchedAt = new Date(this.now()).toISOString();
    // Counted like requests[], which includes replies set aside at their output limit.
    this.switchedAtRequest = this.requests.length + 1;
  }

  /** A participant turn or impressions request went out with `sent` after `conversation`. */
  requested(
    mode: ActorConversation["mode"],
    conversation: CarriedConversation,
    sent: readonly unknown[],
    kind?: "impressions",
  ): void {
    const marker = kind === undefined ? {} : { kind };
    if (mode !== "explicit_context") {
      this.requests.push({ mode: "threaded", ...marker });
      return;
    }
    const carried = conversation.size();
    // Only summaries a request carried count; the conversation also trims after the last reply.
    this.summarizedTurns = carried.notedTurns;
    this.requests.push({
      mode: "explicit_context",
      ...marker,
      carriedExchanges: carried.exchanges,
      carriedScreenshots: carried.screenshots,
      estimatedInputTokens: carried.estimatedTokens + estimateTokens(sent),
    });
  }

  snapshot(mode: ActorConversation["mode"]): ActorConversation {
    return {
      mode,
      ...(this.explicitReason === undefined ? {} : { explicitReason: this.explicitReason }),
      ...(this.rejection === undefined ? {} : { rejection: this.rejection }),
      ...(this.switchedAt === undefined ? {} : { switchedAt: this.switchedAt }),
      ...(this.switchedAtRequest === undefined
        ? {}
        : { switchedAtRequest: this.switchedAtRequest }),
      summarizedTurns: this.summarizedTurns,
      requests: this.requests.map((request) => ({ ...request })),
    };
  }
}
