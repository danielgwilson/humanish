import type { CuaTurnRequest } from "./loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import type { ActorConversation } from "../contract.js";
import { CarriedConversation, estimateTokens } from "./openai-context.js";
import {
  buildCallOutput,
  buildContinuationRequest,
  buildInitialRequest,
  hintItems,
  openingMessage,
  type OpenAiCuContext,
  type OpenAiReasoningSummary,
  type ParsedOpenAiResponse,
} from "./openai-wire.js";

// The request bodies the OpenAI computer-use provider sends, over its conversation state: the
// first turn, every later turn, and the read-only closing report. The provider owns the state
// and the transport; this module decides what each request carries and how a reply moves the
// conversation on.

/** Request settings fixed for a provider's whole session. */
export interface OpenAiRequestSettings {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly safetyIdentifier?: string;
}

/** The conversation as the provider has it after its last accepted reply. */
export interface OpenAiConversationState {
  lastResponseId: string | undefined;
  /** computer_call ids the next request owes an output for. */
  pendingCallIds: string[];
  /** Accepted replies so far; the next request is number `replies + 1`. */
  replies: number;
  /** The whole conversation, which explicit-context requests carry within its token budget. */
  conversation: CarriedConversation;
  /** explicit_context after a zero-data-retention rejection or when configured. */
  mode: "previous_response_id" | "explicit_context";
  /** Undefined once the account or model rejected reasoning summaries. */
  reasoningSummary: OpenAiReasoningSummary | undefined;
}

/** The closing report's output limit: its own cap, or the declared limit when that is lower. */
const CLOSING_OUTPUT_LIMIT = 1024;

function requestContext(
  settings: OpenAiRequestSettings,
  state: OpenAiConversationState,
  instructions: string,
): OpenAiCuContext {
  return {
    stateless: state.mode === "explicit_context",
    model: settings.model,
    instructions,
    reasoningEffort: settings.reasoningEffort,
    ...(settings.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: settings.maxOutputTokens }),
    ...(state.reasoningSummary === undefined ? {} : { reasoningSummary: state.reasoningSummary }),
    ...(settings.safetyIdentifier === undefined
      ? {}
      : { safetyIdentifier: settings.safetyIdentifier }),
  };
}

/** No reply has been accepted yet, so the next request opens the conversation. */
function isFirstTurn(state: OpenAiConversationState): boolean {
  return state.replies === 0;
}

/**
 * The items the next request adds to the conversation: the opening message with the first
 * screen, or an output for each pending computer_call with the latest screenshot and any hint.
 * Built once per turn, so every attempt at the request and the accepted reply see the same items.
 */
export function turnInputItems(
  state: OpenAiConversationState,
  req: CuaTurnRequest,
): readonly unknown[] {
  if (isFirstTurn(state)) return [openingMessage(req.instructions, req.observation.screenshot)];
  return [
    ...state.pendingCallIds.map((id) =>
      buildCallOutput(id, req.observation.screenshot, req.acknowledgedSafetyChecks),
    ),
    ...hintItems(req.contextHint),
  ];
}

/**
 * The body of the next participant request: the opening request, or a continuation carrying
 * `sent` (turnInputItems). A threaded continuation names the previous response; an
 * explicit-context one carries the conversation ahead of `sent`.
 */
export function turnRequestBody(
  settings: OpenAiRequestSettings,
  state: OpenAiConversationState,
  req: CuaTurnRequest,
  sent: readonly unknown[],
): Record<string, unknown> {
  const ctx = requestContext(settings, state, req.instructions);
  if (isFirstTurn(state)) return buildInitialRequest(ctx, req.observation.screenshot);
  return buildContinuationRequest({
    ctx,
    previousResponseId: state.lastResponseId,
    callOutputs: [...sent],
    ...(state.mode === "explicit_context"
      ? { explicitContextItems: state.conversation.carried() }
      : {}),
  });
}

/** The body of the read-only closing report: no tools, a small output limit, a strict schema. */
export function debriefRequestBody(
  settings: OpenAiRequestSettings,
  state: OpenAiConversationState,
  req: CuaTurnRequest,
  sent: readonly unknown[],
): Record<string, unknown> {
  return {
    ...turnRequestBody(settings, state, req, sent),
    tool_choice: "none",
    max_output_tokens: Math.min(
      settings.maxOutputTokens ?? CLOSING_OUTPUT_LIMIT,
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
 * Move the conversation on to an accepted reply to a request that added `sent`. A participant
 * reply cut off by the output limit is set aside, so the next request is the same one again
 * (outputLimitRetry); its actions never run, so no call output is owed for them.
 */
export function acceptReply(
  state: OpenAiConversationState,
  parsed: ParsedOpenAiResponse,
  closing: boolean,
  sent: readonly unknown[],
): void {
  if (!closing && parsed.turn.interruption === "output_limit") return;
  if (parsed.turn.responseId !== undefined) state.lastResponseId = parsed.turn.responseId;
  state.pendingCallIds = parsed.callIds;
  state.replies += 1;
  state.conversation.accept(state.replies, sent, parsed.outputItems);
}

/** The trace's account of how a session carried its conversation (ActorConversation). */
export class ConversationRecord {
  private explicitReason: ActorConversation["explicitReason"];
  private switchedAt: string | undefined;
  private switchedAtRequest: number | undefined;
  private readonly requests: ActorConversation["requests"] = [];

  constructor(
    configured: boolean,
    private readonly now: () => number,
  ) {
    if (configured) this.explicitReason = "configured";
  }

  /** The organization rejected server-side state, so the next request is explicit_context. */
  switched(state: OpenAiConversationState): void {
    this.explicitReason = "zdr_rejection";
    this.switchedAt = new Date(this.now()).toISOString();
    this.switchedAtRequest = state.replies + 1;
  }

  /** A participant request just went out with `sent` after the carried conversation. */
  requested(state: OpenAiConversationState, sent: readonly unknown[]): void {
    if (state.mode !== "explicit_context") {
      this.requests.push({ mode: "threaded" });
      return;
    }
    const carried = state.conversation.size();
    this.requests.push({
      mode: "explicit_context",
      carriedExchanges: carried.exchanges,
      carriedScreenshots: carried.screenshots,
      estimatedInputTokens: carried.estimatedTokens + estimateTokens(sent),
    });
  }

  snapshot(state: OpenAiConversationState): ActorConversation {
    return {
      mode: state.mode === "explicit_context" ? "explicit_context" : "threaded",
      ...(this.explicitReason === undefined ? {} : { explicitReason: this.explicitReason }),
      ...(this.switchedAt === undefined ? {} : { switchedAt: this.switchedAt }),
      ...(this.switchedAtRequest === undefined
        ? {}
        : { switchedAtRequest: this.switchedAtRequest }),
      summarizedTurns: state.conversation.collapsed,
      requests: this.requests.map((request) => ({ ...request })),
    };
  }
}
