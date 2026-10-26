import type { ActorConversation } from "../contract.js";
import {
  ComputerUseAdmissionLimitError,
  isComputerUseAdmissionLimitError,
} from "./admission-limit.js";
import { ComputerUsePromptRefusedError } from "./provider-error.js";
import type { CuaProvider, CuaSpendGate, CuaTurn, CuaTurnRequest } from "./loop.js";
import type { ClosingRequest } from "./closing-account.js";
import {
  OpenAiConversation,
  type ConversationRequest,
  type ZdrRejection,
} from "./openai-conversation.js";
import type { OpenAiReasoningSummary } from "./openai-wire.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import { isMaxOutputTokens } from "../output-token-limit.js";
import { OPENAI_RESPONSES_URL } from "../openai-endpoint.js";
import {
  API_COMPUTER_USE_CAPABILITIES,
  createWireCapture,
  defaultDelay,
  defaultFetch,
  isAbortError,
  retryDelayMs,
  sendRequest,
  wireCaptureDir,
  type FetchLike,
  type SentRequest,
  type WireCapture,
} from "./provider-http.js";

// A public-safe re-derivation of the OpenAI Responses API computer-use provider,
// behind the CuaProvider port from src/actors/computer-use/loop.ts. The pure wire mapping
// (openAiActionToCua, parseOpenAiResponse and the request builders) is in openai-wire.ts, and
// what each request carries, with the trace's record of it, is in openai-conversation.ts.
// This module is the live shim: createOpenAiResponsesProvider does a raw POST to the
// Responses endpoint (no SDK dependency) through an injectable FetchLike seam, so the retry,
// ZDR fallback, and state threading are testable with a fake.
//
// Public-safety invariants (this is an OSS repo): the apiKey only ever appears in
// the Authorization header, never in a returned object, thrown error, or comment.
// Request bodies (which carry base64 screenshots and the persona instructions)
// and screenshots are never logged or returned; nextTurn returns only a CuaTurn,
// and the engine handles redaction of CuaTurn fields downstream. Error messages
// carry the HTTP status only, never the response body (it can echo the input).
//
// Response wire capture (HUMANISH_CUA_WIRE_CAPTURE_DIR) is described in provider-http.ts.

export const OPENAI_RESPONSES_CU_CAPABILITIES = API_COMPUTER_USE_CAPABILITIES;

// The computer-use participant default. On the Taskly benchmark it matched gpt-5.6-sol's
// analysis recall at about a third of the participant cost
// (docs/evidence/benchmark/2026-10-25-participant-default.md). Explicit tier id so trace
// provenance and the rate-table key stay stable if OpenAI repoints an alias.
export const DEFAULT_OPENAI_CU_MODEL = "gpt-6.1-sol";

/**
 * The model the Codex terminal route passes when a study names none. The benchmark behind the
 * computer-use default ran OpenAI computer-use participants only, so the terminal route keeps
 * gpt-5.6-sol.
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/**
 * The effort a request carries when a study declares none. Exported because a default that only
 * exists as a literal inside the provider is exactly how it stayed invisible: the study surface has
 * to be able to say what will actually run.
 */
export const DEFAULT_OPENAI_CU_REASONING_EFFORT: ReasoningEffort = "medium";

/**
 * The provider error codes a participant's reason may name. Read from a non-ok body, which is never
 * kept or logged (it can echo the input); only a code on this list crosses over.
 */
const NAMED_PROVIDER_ERROR_CODES = [
  "misalignment_policy_violation",
  "slow_down",
  "server_is_overloaded",
  "rate_limit_exceeded",
  "insufficient_quota",
  "model_not_found",
  "context_length_exceeded",
  // 400 codes seen on /v1/responses (docs, SDK types and user reports, researched 2026-09-30).
  "previous_response_not_found",
  "invalid_value",
  "invalid_type",
  "unsupported_value",
  "unsupported_parameter",
  "invalid_prompt",
  "invalid_image",
  "invalid_image_format",
  "invalid_base64_image",
  "invalid_image_url",
  "image_too_large",
  "image_parse_error",
  "image_content_policy_violation",
] as const;

/** A request parameter path such as `input[3].output[1].image_url` or `reasoning.effort`. */
const REQUEST_PARAM_PATH = /^[A-Za-z_][A-Za-z0-9_.[\]]{0,80}$/;

/**
 * What a 400 names about itself: an allowlisted `code`, else `invalid_request_error` when that is
 * the `type` (several 400s carry `code: null`), plus the rejected parameter's path. Only these
 * identifier-shaped fields cross over; the message can echo the input and never does.
 */
export function requestRejectionDetail(bodyText: string): string | undefined {
  let error: unknown;
  try {
    error = (JSON.parse(bodyText) as { error?: unknown }).error;
  } catch {
    return namedProviderErrorCode(bodyText);
  }
  if (typeof error !== "object" || error === null) return undefined;
  const { code, type, param } = error as { code?: unknown; type?: unknown; param?: unknown };
  const named =
    typeof code === "string" && (NAMED_PROVIDER_ERROR_CODES as readonly string[]).includes(code)
      ? code
      : type === "invalid_request_error"
        ? type
        : undefined;
  const at = typeof param === "string" && REQUEST_PARAM_PATH.test(param) ? param : undefined;
  if (named === undefined) return at === undefined ? undefined : `at ${at}`;
  return at === undefined ? named : `${named} at ${at}`;
}

export function namedProviderErrorCode(bodyText: string): string | undefined {
  const match = /"code"\s*:\s*"([a-z_]+)"/.exec(bodyText);
  const code = match?.[1];
  return code !== undefined && (NAMED_PROVIDER_ERROR_CODES as readonly string[]).includes(code)
    ? code
    : undefined;
}

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * How hard the model is asked to think per turn. Absent = the provider default below.
   * The vocabulary is the documented union across models; support is model-dependent, so an
   * unsupported level surfaces as the provider's own first-turn error rather than a silent
   * downgrade to something the trace would then misreport. See src/actors/reasoning-effort.ts.
   */
  reasoningEffort?: ReasoningEffort;
  /** Optional positive integer output limit per response, including reasoning. Not a spend cap. */
  maxOutputTokens?: number;
  /** OpenAI Fast mode on every request; absent sends no `service_tier`. */
  serviceTier?: "fast";
  /**
   * Reasoning-summary capture. Defaults to "auto" (the provider picks the best
   * summarizer the model supports); "off" never asks. If the account/model rejects the
   * request (e.g. an org not verified for reasoning summaries), the provider latches
   * summaries off for the session and retries the same turn; the run degrades to
   * a run without summaries instead of failing after spend. The trace records the absence:
   * no summary means no `reasoning` trace items and `counts.reasonings` stays 0.
   */
  reasoningSummary?: OpenAiReasoningSummary | "off";
  safetyIdentifier?: string;
  endpoint?: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
  /** Internal strict-accounting policy: one HTTP dispatch, including policy negotiation.
   * Used by sessions with requireReportedUsageForSpendCap; missing usage must stop before another
   * paid request. */
  singleDispatch?: boolean;
  delayFn?: (ms: number) => Promise<void>;
  /** Carry the conversation on the client from the first request (explicit_context). */
  zeroDataRetention?: boolean;
  /** The clock the trace's conversation record reads. Defaults to Date.now. */
  now?: () => number;
  /**
   * Environment for the wire-capture gate (HUMANISH_CUA_WIRE_CAPTURE_DIR; see
   * provider-http.ts). Injectable so deterministic tests control the gate without
   * mutating process.env. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
}

// A typed error so nextTurn can distinguish a ZDR-policy rejection (recoverable
// by switching to explicit-context mode) from any other non-ok status. It never
// carries the apiKey or the response body.
class ZdrError extends Error {
  constructor(readonly rejection: ZdrRejection) {
    super(
      rejection === "stored_item"
        ? "OpenAI Responses could not find an item the request referenced: the server keeps none for this organization (zero data retention)"
        : "OpenAI Responses rejected server-side state (zero data retention)",
    );
    this.name = "ZdrError";
  }
}

/** The message of a 404 for an item the server never kept, as the wire sends it. */
const STORED_ITEM_NOT_FOUND = /Item with id '?[A-Za-z0-9_-]+'? not found/;

/**
 * Error codes that name a failure of their own. Their messages can echo request text, such as a
 * model name or the prompt, so the words below must not turn them into a retention answer.
 */
const OTHER_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_prompt",
  "model_not_found",
  "context_length_exceeded",
  "rate_limit_exceeded",
  "insufficient_quota",
  "invalid_image",
  "invalid_image_format",
  "invalid_base64_image",
  "invalid_image_url",
  "image_too_large",
  "image_parse_error",
  "image_content_policy_violation",
]);

// A 400 or 404 whose body says the organization cannot use server-side response state, so the
// provider must carry the conversation itself (explicit-context mode). A 404 counts only with the
// stored-item message. Captured bodies are in tests/fixtures/openai-store-less/.
function zdrRejection(status: 400 | 404, bodyText: string): ZdrRejection | undefined {
  const code = namedProviderErrorCode(bodyText);
  if (code !== undefined && OTHER_FAILURE_CODES.has(code)) return undefined;
  if (status === 404) return STORED_ITEM_NOT_FOUND.test(bodyText) ? "stored_item" : undefined;
  if (/zero[ -]data[ -]retention/i.test(bodyText)) return "zero_data_retention";
  if (bodyText.includes("previous_response_id")) return "previous_response";
  if (STORED_ITEM_NOT_FOUND.test(bodyText)) return "stored_item";
  return undefined;
}

// A typed error so nextTurn can latch reasoning summaries off and retry the turn
// (an org not verified for summaries, or a model without a summarizer, 400s the
// whole request). Like ZdrError it never carries the response body.
class SummaryRejectionError extends Error {
  constructor() {
    super("OpenAI Responses rejected the reasoning.summary request");
    this.name = "SummaryRejectionError";
  }
}

// A 400 whose body names the reasoning-summary feature. Observed live shapes:
// "Unsupported parameter: 'reasoning.summary' ..." and "Your organization must
// be verified to generate reasoning summaries."
function isSummaryRejection(bodyText: string): boolean {
  return bodyText.includes("reasoning.summary") || bodyText.includes("reasoning summaries");
}

/** What one POST needs from its provider. */
interface ResponsesTransport {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetchFn: FetchLike;
  readonly delayFn: (ms: number) => Promise<void>;
  readonly capture: WireCapture;
  /** An interaction attempt may have reached the provider without its usage coming back. */
  markUsageIncomplete(): void;
}

// POST the JSON body and return the parsed JSON on success. Retries on
// transient statuses (408/409/429/>=500). Maps a ZDR-policy 400 to a typed
// ZdrError; any other non-ok status throws with the status only (never the
// body, which can echo the input/screenshot).
async function postResponse(
  transport: ResponsesTransport,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  retries: number,
  interaction: boolean,
  spend: CuaSpendGate | undefined,
): Promise<unknown> {
  // Preflight the deterministic next capture leaf before any network side
  // effect. A hostile generated path must fail with zero provider calls.
  await transport.capture.prepareNext();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${transport.apiKey}`,
    "Content-Type": "application/json",
  };
  const payload = JSON.stringify(body);
  let lastStatus = 0;
  let sawNetworkError = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    signal?.throwIfAborted();
    let res: SentRequest;
    try {
      // The reply body is read inside the dispatch, so losing it counts as a lost request.
      res = await sendRequest(transport.fetchFn, transport.endpoint, {
        method: "POST",
        headers,
        body: payload,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // An explicit local pre-dispatch limit is terminal. Recreate the fixed safe payload
      // rather than propagating caller-added message/context through the transport seam.
      if (isComputerUseAdmissionLimitError(error)) throw new ComputerUseAdmissionLimitError();
      // Dispatch may have reached the provider. Preserve this uncertainty even when a later
      // retry succeeds or is refused locally; only that later refusal is known not to dispatch.
      // Under a spend gate the loop accounts for the attempt instead: it books a resend below
      // and marks an abort or a final failure itself.
      if (interaction && spend === undefined) transport.markUsageIncomplete();
      if (signal?.aborted === true || isAbortError(error)) {
        throw error;
      }
      sawNetworkError = true;
      if (attempt < retries) {
        spend?.beforeResend();
        await transport.delayFn(2 ** attempt * 200);
        continue;
      }
      throw new Error("OpenAI Responses network error");
    }
    if (res.ok) {
      const parsed = res.reply;
      // Capture after ok and before parse-to-CuaTurn: responses only, never the
      // request (screenshots/instructions) and never a non-ok body (input echo).
      await transport.capture.record(parsed);
      return parsed;
    }
    lastStatus = res.status;
    if (res.status === 404) {
      // A store-less organization answers a reference to an item it never kept with 404.
      const bodyText = await res.text().catch(() => "");
      const rejection = zdrRejection(404, bodyText);
      if (rejection !== undefined) throw new ZdrError(rejection);
      const code = namedProviderErrorCode(bodyText);
      throw new Error(`OpenAI Responses 404${code === undefined ? "" : ` ${code}`}`);
    }
    if (res.status === 400) {
      const bodyText = await res.text();
      const rejection = zdrRejection(400, bodyText);
      if (rejection !== undefined) throw new ZdrError(rejection);
      if (isSummaryRejection(bodyText)) {
        throw new SummaryRejectionError();
      }
      // A usage-policy flag is terminal for this prompt: typed so the loop names it, never retried.
      if (namedProviderErrorCode(bodyText) === "invalid_prompt") {
        throw new ComputerUsePromptRefusedError("OpenAI", "400 invalid_prompt");
      }
      const detail = requestRejectionDetail(bodyText);
      throw new Error(`OpenAI Responses 400${detail === undefined ? "" : ` ${detail}`}`);
    }
    if (res.status === 403) {
      // Misalignment monitoring (2026-09-03): the provider can stop a threaded conversation
      // mid-run with 403 misalignment_policy_violation; there is no resume path, and earlier
      // actions may already have executed. Named, terminal, never retried.
      const bodyText = await res.text().catch(() => "");
      if (namedProviderErrorCode(bodyText) === "misalignment_policy_violation") {
        throw new Error(
          "OpenAI Responses 403 misalignment_policy_violation: the provider stopped this conversation and it cannot be resumed",
        );
      }
      throw new Error("OpenAI Responses 403");
    }
    const retryable =
      res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      await transport.delayFn(retryDelayMs(attempt, res.headers));
      continue;
    }
    const code = namedProviderErrorCode(await res.text().catch(() => ""));
    throw new Error(`OpenAI Responses ${res.status}${code === undefined ? "" : ` ${code}`}`);
  }
  if (sawNetworkError) {
    throw new Error("OpenAI Responses network error");
  }
  throw new Error(`OpenAI Responses ${lastStatus}`);
}

/**
 * Create a stateful CuaProvider backed by the OpenAI Responses API. The first
 * turn opens a session (buildInitialRequest); subsequent turns send the prior
 * call outputs (with the latest screenshot) and thread state via
 * previous_response_id, transparently falling back to explicit-context mode if
 * the account rejects server-side retention. Transient HTTP failures are retried
 * with exponential backoff. Returns only a CuaTurn from nextTurn; nothing
 * sensitive (the key, the request body, the screenshot, the raw response body)
 * is ever returned or logged.
 */
export function createOpenAiResponsesProvider(
  options: OpenAiResponsesProviderOptions,
): CuaProvider {
  if (options.maxOutputTokens !== undefined && !isMaxOutputTokens(options.maxOutputTokens)) {
    throw new Error("maxOutputTokens must be a positive safe integer.");
  }
  const maxOutputTokens = options.maxOutputTokens;
  const model = options.model ?? DEFAULT_OPENAI_CU_MODEL;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_OPENAI_CU_REASONING_EFFORT;
  const maxRetries = options.singleDispatch === true ? 0 : (options.maxRetries ?? 3);
  const capture = createWireCapture(wireCaptureDir(options.env ?? process.env));
  let interactionUsageIncomplete = false;
  const conversation = new OpenAiConversation({
    model,
    reasoningEffort,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(options.safetyIdentifier === undefined
      ? {}
      : { safetyIdentifier: options.safetyIdentifier }),
    ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
    reasoningSummary:
      options.reasoningSummary === "off" ? undefined : (options.reasoningSummary ?? "auto"),
    zeroDataRetention: options.zeroDataRetention === true,
    now: options.now ?? Date.now,
  });

  const transport: ResponsesTransport = {
    endpoint: options.endpoint ?? OPENAI_RESPONSES_URL,
    apiKey: options.apiKey,
    fetchFn: options.fetchFn ?? defaultFetch(),
    delayFn: options.delayFn ?? defaultDelay,
    capture,
    markUsageIncomplete: () => {
      interactionUsageIncomplete = true;
    },
  };
  const post = (
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    retries = maxRetries,
    interaction = true,
    spend?: CuaSpendGate,
  ): Promise<unknown> => postResponse(transport, body, signal, retries, interaction, spend);

  // POST with the recoverable-policy latches: a ZDR rejection switches to explicit-context mode; a
  // reasoning-summary rejection latches summaries off. Each latch can flip only once, so the loop
  // is bounded; anything else rethrows. The body is rebuilt per attempt so a flipped latch shows.
  const postTurn = async (
    request: ConversationRequest,
    signal: AbortSignal,
    spend: CuaSpendGate | undefined,
  ): Promise<unknown> => {
    if (options.singleDispatch === true) return post(request.body(), signal, 0);
    for (;;) {
      try {
        return await post(request.body(), signal, maxRetries, true, spend);
      } catch (error) {
        if (error instanceof SummaryRejectionError && conversation.dropReasoningSummaries()) {
          continue;
        }
        if (error instanceof ZdrError && conversation.switchToExplicitContext(error.rejection)) {
          continue;
        }
        throw error;
      }
    }
  };

  const requestTurn = async (
    req: CuaTurnRequest,
    signal: AbortSignal,
    spend?: CuaSpendGate,
  ): Promise<CuaTurn> => {
    await capture.prepareNext();
    const request = conversation.request(req);
    return request.accept(await postTurn(request, signal, spend));
  };

  // Each closing request is posted once: no HTTP or policy-latch retries. A reply with no valid
  // account keeps its usage and gives no report: refusals, incomplete output, malformed JSON and
  // invalid shapes are never promoted into a structured finding.
  const requestClosing = (
    req: CuaTurnRequest,
    signal: AbortSignal,
    closing: ClosingRequest,
  ): Promise<CuaTurn> => conversation.close(req, closing, (body) => post(body, signal, 0, false));

  return {
    id: "openai-responses-cu",
    version: model,
    // The effort the wire actually carries, not the one the study asked for: the provider defaults
    // an absent request to "medium", and the trace has to say what produced it.
    modelSettings: {
      reasoningEffort,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
    },
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    // This is a vision provider: nextTurn sends the screenshot as the computer_call_output, so
    // it cannot reason over a screenshot-less observation. The loop reads this to fail closed
    // (harness_error) when a state-only executor is paired with it (provider-authoring contract).
    requiresFrame: true,
    outputLimitRetry: true,
    get interactionUsageIncomplete() {
      return interactionUsageIncomplete;
    },
    nextTurn: (req, signal, spend) => requestTurn(req, signal, spend),
    get conversation(): ActorConversation {
      return conversation.record();
    },
    // Both are offered in both modes. A threaded request reads the session the server holds; an
    // explicit_context one carries its newest screens whole and its oldest turns summarized past
    // the budget, which the trace's conversation record counts. A participant that worked a long
    // session writes its closing account from what it carries, as a person writes one from memory.
    debrief: (req, signal) => requestClosing(req, signal, "report"),
    requestImpressions: (req, signal) => requestClosing(req, signal, "impressions"),
  };
}
