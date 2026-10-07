import type { CuaTurn, CuaTurnRequest } from "./loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import type { ActorConversation } from "../contract.js";
import { CarriedConversation } from "./openai-context.js";
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
  /** The summaries to ask for until the account or model rejects them; absent asks for none. */
  readonly reasoningSummary?: OpenAiReasoningSummary;
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
   * The request was answered. Moves the conversation on to the reply and returns its turn.
   */
  accept(reply: unknown): CuaTurn;
}

/** The closing report's output limit: its own cap, or the declared limit when that is lower. */
const CLOSING_OUTPUT_LIMIT = 1024;

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

  constructor(private readonly settings: OpenAiConversationSettings) {
    this.mode = settings.zeroDataRetention ? "explicit_context" : "threaded";
    this.reasoningSummary = settings.reasoningSummary;
  }

  /**
   * The next request, carrying `req`'s screen: the opening request, or the outputs the latest
   * reply's computer calls are owed. A closing report asks for a strict JSON report and no tools.
   */
  request(req: CuaTurnRequest, closing = false): ConversationRequest {
    const sent = this.newItems(req);
    return {
      body: () => (closing ? this.closingBody(req, sent) : this.turnBody(req, sent)),
      accept: (reply) => this.accept(reply, closing, sent),
    };
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

  /** The read-only closing report: no tools, a small output limit, a strict schema. */
  private closingBody(req: CuaTurnRequest, sent: readonly unknown[]): Record<string, unknown> {
    return {
      ...this.turnBody(req, sent),
      tool_choice: "none",
      max_output_tokens: Math.min(
        this.settings.maxOutputTokens ?? CLOSING_OUTPUT_LIMIT,
        CLOSING_OUTPUT_LIMIT,
      ),
      text: {
        format: {
          type: "json_schema",
          name: "participant_closing_report",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "frictionReports"],
            properties: {
              summary: { type: "string" },
              frictionReports: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
  }

  /**
   * Move the conversation on to a reply to a request that added `sent`. A participant reply cut
   * off by the output limit is set aside, so the next request is the same one again
   * (outputLimitRetry); its actions never run, so no call output is owed for them.
   */
  private accept(reply: unknown, closing: boolean, sent: readonly unknown[]): CuaTurn {
    const parsed = parseOpenAiResponse(reply);
    if (!closing && parsed.turn.interruption === "output_limit") return parsed.turn;
    if (parsed.turn.responseId !== undefined) this.lastResponseId = parsed.turn.responseId;
    this.pendingCallIds = parsed.callIds;
    this.replies += 1;
    this.carried.accept(this.replies, sent, parsed.outputItems);
    return parsed.turn;
  }
}
