import type { CuaTurnRequest } from "./loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import {
  buildCallOutput,
  buildContinuationRequest,
  buildInitialRequest,
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
  /** The last reply's output items, resent in explicit-context mode. */
  lastOutputItems: unknown[];
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
  return state.lastResponseId === undefined && state.pendingCallIds.length === 0;
}

/**
 * The body of the next participant request: the opening request with the first screen, or a
 * continuation that answers each pending computer_call with the latest screenshot.
 */
export function turnRequestBody(
  settings: OpenAiRequestSettings,
  state: OpenAiConversationState,
  req: CuaTurnRequest,
): Record<string, unknown> {
  const ctx = requestContext(settings, state, req.instructions);
  if (isFirstTurn(state)) return buildInitialRequest(ctx, req.observation.screenshot);
  return buildContinuationRequest({
    ctx,
    previousResponseId: state.lastResponseId,
    callOutputs: state.pendingCallIds.map((id) =>
      buildCallOutput(id, req.observation.screenshot, req.acknowledgedSafetyChecks),
    ),
    ...(req.contextHint === undefined ? {} : { contextHint: req.contextHint }),
    ...(state.mode === "explicit_context" ? { explicitContextItems: state.lastOutputItems } : {}),
  });
}

/** The body of the read-only closing report: no tools, a small output limit, a strict schema. */
export function debriefRequestBody(
  settings: OpenAiRequestSettings,
  state: OpenAiConversationState,
  req: CuaTurnRequest,
): Record<string, unknown> {
  return {
    ...turnRequestBody(settings, state, req),
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
 * Move the conversation on to an accepted reply. A participant reply cut off by the output limit
 * is set aside, so the next request is the same one again (outputLimitRetry); its actions never
 * run, so no call output is owed for them.
 */
export function acceptReply(
  state: OpenAiConversationState,
  parsed: ParsedOpenAiResponse,
  closing: boolean,
): void {
  if (!closing && parsed.turn.interruption === "output_limit") return;
  if (parsed.turn.responseId !== undefined) state.lastResponseId = parsed.turn.responseId;
  state.pendingCallIds = parsed.callIds;
  state.lastOutputItems = parsed.outputItems;
}
