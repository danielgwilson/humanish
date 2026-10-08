import type { CuaTurn, CuaTurnRequest } from "./loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import {
  closingReportSchema,
  impressionsReplySchema,
  strictOutputSchema,
} from "../closing-report.js";
import type { ActorConversation } from "../contract.js";
import { CarriedConversation, estimateTokens } from "./openai-context.js";
import {
  buildCallOutput,
  buildContinuationRequest,
  buildInitialRequest,
  hintItems,
  openingMessage,
  parseOpenAiResponse,
  type OpenAiCuContext,
  type OpenAiReasoningSummary,
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

/**
 * What a closing request asks for: the closing report after a harness-owned stop, or only
 * impressions after the participant ended the session itself.
 */
export type ClosingRequest = "report" | "impressions";

const CLOSING_FORMATS: Record<ClosingRequest, Record<string, unknown>> = {
  report: {
    type: "json_schema",
    name: "participant_closing_report",
    strict: true,
    schema: strictOutputSchema(closingReportSchema),
  },
  impressions: {
    type: "json_schema",
    name: "participant_impressions",
    strict: true,
    schema: strictOutputSchema(impressionsReplySchema),
  },
};

export class OpenAiConversation {
  private lastResponseId: string | undefined;
  /** computer_call ids the next request owes an output for. */
  private pendingCallIds: readonly string[] = [];
  /** Accepted replies so far; the next request is number `replies + 1`. */
  private replies = 0;
  /** The whole conversation, which explicit-context requests carry within its token budget. */
  private readonly carried = new CarriedConversation();
  private mode: ActorConversation["mode"];
  /** Undefined once the account or model rejected reasoning summaries. */
  private reasoningSummary: OpenAiReasoningSummary | undefined;
  private readonly evidence: ConversationRecord;

  constructor(private readonly settings: OpenAiConversationSettings) {
    this.mode = settings.zeroDataRetention ? "explicit_context" : "threaded";
    this.reasoningSummary = settings.reasoningSummary;
    this.evidence = new ConversationRecord(settings.zeroDataRetention, settings.now);
  }

  /**
   * The next request, carrying `req`'s screen: the opening request, or the outputs the latest
   * reply's computer calls are owed. A closing request asks for strict JSON and no tools.
   */
  request(req: CuaTurnRequest, closing?: ClosingRequest): ConversationRequest {
    const sent = this.newItems(req);
    return {
      body: () =>
        closing === undefined ? this.turnBody(req, sent) : this.closingBody(req, sent, closing),
      accept: (reply) => this.accept(reply, closing, sent),
    };
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

  /**
   * Whether the server holds the whole session, so a closing report threaded on it reads every
   * turn. An explicit-context conversation summarizes its oldest turns past its budget, configured
   * or switched to at runtime.
   */
  get serverHoldsSession(): boolean {
    return this.mode === "threaded" && this.lastResponseId !== undefined;
  }

  /** The trace's account of how the conversation was carried (ActorConversation). */
  record(): ActorConversation {
    return this.evidence.snapshot(this.mode);
  }

  /**
   * The items a request adds to the conversation: the opening message with the first screen, or
   * an output for each pending computer_call with the latest screenshot and any hint.
   */
  private newItems(req: CuaTurnRequest): readonly unknown[] {
    if (this.replies === 0) return [openingMessage(req.instructions, req.observation.screenshot)];
    return [
      ...this.pendingCallIds.map((id) =>
        buildCallOutput(id, req.observation.screenshot, req.acknowledgedSafetyChecks),
      ),
      ...hintItems(req.contextHint),
    ];
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
    };
  }

  /**
   * A participant request: the opening request, or a continuation carrying `sent`. A threaded
   * continuation names the previous response; an explicit-context one carries the conversation
   * ahead of `sent`.
   */
  private turnBody(req: CuaTurnRequest, sent: readonly unknown[]): Record<string, unknown> {
    const ctx = this.context(req.instructions);
    if (this.replies === 0) return buildInitialRequest(ctx, req.observation.screenshot);
    return buildContinuationRequest({
      ctx,
      previousResponseId: this.lastResponseId,
      callOutputs: [...sent],
      ...(this.mode === "explicit_context" ? { explicitContextItems: this.carried.carried() } : {}),
    });
  }

  /** A read-only closing request: no tools, its own output limit, a strict schema. */
  private closingBody(
    req: CuaTurnRequest,
    sent: readonly unknown[],
    closing: ClosingRequest,
  ): Record<string, unknown> {
    return {
      ...this.turnBody(req, sent),
      tool_choice: "none",
      max_output_tokens: Math.min(
        this.settings.maxOutputTokens ?? CLOSING_OUTPUT_LIMIT,
        CLOSING_OUTPUT_LIMIT,
      ),
      text: { format: CLOSING_FORMATS[closing] },
    };
  }

  /**
   * Move the conversation on to a reply to a request that added `sent`. A participant reply cut
   * off by the output limit is set aside, so the next request is the same one again
   * (outputLimitRetry); its actions never run, so no call output is owed for them.
   */
  private accept(
    reply: unknown,
    closing: ClosingRequest | undefined,
    sent: readonly unknown[],
  ): CuaTurn {
    // Recorded before the reply is accepted: accepting can cut the carried history, and the record
    // counts what this request carried.
    if (closing !== "report") this.evidence.requested(this.mode, this.carried, sent, closing);
    const parsed = parseOpenAiResponse(reply);
    if (closing === undefined && parsed.turn.interruption === "output_limit") return parsed.turn;
    if (parsed.turn.responseId !== undefined) this.lastResponseId = parsed.turn.responseId;
    this.pendingCallIds = parsed.callIds;
    this.replies += 1;
    this.carried.accept(this.replies, sent, parsed.outputItems);
    return parsed.turn;
  }
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
