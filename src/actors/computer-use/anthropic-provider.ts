import type { ActorConversation } from "../contract.js";
import { isMaxOutputTokens } from "../output-token-limit.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import { AnthropicConversation } from "./anthropic-conversation.js";
import { ANTHROPIC_EFFORTS, forCapture, type AnthropicEffort } from "./anthropic-wire.js";
import type { ClosingRequest } from "./closing-account.js";
import type { CuaProvider, CuaSpendGate, CuaTurn, CuaTurnRequest } from "./loop.js";
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

// The Anthropic Messages API computer-use provider, behind the CuaProvider port. What each request
// carries is anthropic-conversation.ts and the wire mapping is anthropic-wire.ts; this module
// posts the bodies through the FetchLike seam (no SDK: the loop owns retries of a stalled turn and
// the spend gate, which an SDK client would duplicate) and retries what Anthropic bills nothing
// for.
//
// The apiKey appears only in the x-api-key header, never in a returned object, a thrown error or
// a capture. Request bodies (base64 screenshots, the study instructions) are never logged, and an
// error message names the status, the error type and the request path the API names, never the
// body's message, which can quote the request.

/** The Messages endpoint. Callers may pass a test override; nothing reads it from env. */
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Server-side tool-result clearing, and the opt-in that turns an edit of earlier history into a
// 400 rather than silently dropped thinking.
const ANTHROPIC_BETAS = "context-management-2025-06-27,thinking-binding-controls-2026-08-01";

/** The model an Anthropic participant runs when none is named. */
export const DEFAULT_ANTHROPIC_CU_MODEL = "claude-haiku-5-5";

/**
 * The output limit every request carries when the caller names none. The API requires one, so
 * it is always sent and recorded: the largest a non-streaming request should ask for, thinking
 * included.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * The largest request body sent. The Messages API refuses a request over 32 MB, and a session
 * carries every screenshot it took (server-side clearing shortens what the model reads, not what
 * is sent), so a long session reaches it after some 60 to 300 turns.
 */
const REQUEST_BYTE_BUDGET = 30 * 1024 * 1024;

export interface AnthropicMessagesProviderOptions {
  apiKey: string;
  /** Absent runs claude-haiku-5-5. */
  model?: string;
  /**
   * `output_config.effort` on every request: low, medium, high, xhigh or max. Absent sends
   * medium. none and minimal have no Anthropic equivalent and throw.
   */
  reasoningEffort?: ReasoningEffort;
  /** `max_tokens` per request, thinking included. Absent sends 16,000. Not a spend cap. */
  maxOutputTokens?: number;
  /**
   * One HTTP dispatch per turn and no retries, not even of a 429 or 5xx. A capped session never
   * sends a request with unknown usage twice without it: the provider asks the loop to stop
   * instead (CuaProvider.requireReportedUsageForSpendCap).
   */
  singleDispatch?: boolean;
  /** Retries of a request answered 408, 409, 429 or 5xx, which bill nothing. Default 3. */
  maxRetries?: number;
  endpoint?: string;
  fetchFn?: FetchLike;
  delayFn?: (ms: number) => Promise<void>;
  /** Environment for HUMANISH_CUA_WIRE_CAPTURE_DIR (provider-http.ts). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** The error types the Messages API documents; only these cross into an error message. */
const ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
]);

/** A request path such as `messages.2.content.0` that a 400's message starts with. */
const REQUEST_PATH = /^([a-z_]+(?:\.[a-z_0-9]+){0,8}):/;

/** What a non-ok body names about itself: its documented error type and the request path. */
function errorDetail(bodyText: string): string {
  let error: unknown;
  try {
    error = (JSON.parse(bodyText) as { error?: unknown }).error;
  } catch {
    return "";
  }
  if (typeof error !== "object" || error === null) return "";
  const { type, message } = error as { type?: unknown; message?: unknown };
  const named = typeof type === "string" && ERROR_TYPES.has(type) ? ` ${type}` : "";
  const path = typeof message === "string" ? REQUEST_PATH.exec(message)?.[1] : undefined;
  return `${named}${path === undefined ? "" : ` at ${path}`}`;
}

const isRetryable = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

/** What one POST needs from its provider. */
interface MessagesTransport {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetchFn: FetchLike;
  readonly delayFn: (ms: number) => Promise<void>;
  readonly capture: WireCapture;
  /** A participant request may have been billed without its usage coming back. */
  markUsageIncomplete(): void;
}

interface Attempts {
  readonly retries: number;
  /** A participant turn, whose lost usage the trace must report; a closing request is not. */
  readonly interaction: boolean;
  /** Present when the session has a spend cap. */
  readonly spend?: CuaSpendGate | undefined;
}

/**
 * POST `body` and return the parsed reply. A 408, 409, 429 or 5xx is sent again after the
 * Retry-After hint or a backoff, since Anthropic bills no tokens for a request it answers with an
 * error. A request lost in transit may have been billed: without a spend cap it is sent again and
 * the session's usage is marked incomplete; with one it is not sent again, because its cost is
 * unknown and the cap could not bound it.
 */
async function postMessages(
  transport: MessagesTransport,
  body: Record<string, unknown>,
  signal: AbortSignal,
  { retries, interaction, spend }: Attempts,
): Promise<unknown> {
  // Preflight the next capture file before any network side effect.
  await transport.capture.prepareNext();
  const payload = JSON.stringify(body);
  const bytes = Buffer.byteLength(payload);
  if (bytes > REQUEST_BYTE_BUDGET) {
    throw new Error(
      `The participant's conversation reached ${(bytes / 2 ** 20).toFixed(1)} MB with its screenshots, past the Messages API's 32 MB request limit, so no further request was sent. This provider does not compact a long session yet; run shorter sessions for now.`,
    );
  }
  const headers = {
    "x-api-key": transport.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_BETAS,
    "content-type": "application/json",
  };
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    let res: SentRequest;
    try {
      res = await sendRequest(transport.fetchFn, transport.endpoint, {
        method: "POST",
        headers,
        body: payload,
        signal,
      });
    } catch (error) {
      // From dispatch until its reply body is read, a request may have been billed, cancelled
      // ones included. Under a spend cap the loop accounts for it; without one, the trace says so.
      if (interaction && spend === undefined) transport.markUsageIncomplete();
      if (signal.aborted || isAbortError(error)) throw error;
      if (spend !== undefined || attempt >= retries)
        throw new Error("Anthropic Messages request lost in transit");
      await transport.delayFn(2 ** attempt * 200);
      continue;
    }
    if (res.ok) return res.reply;
    if (isRetryable(res.status) && attempt < retries) {
      await transport.delayFn(retryDelayMs(attempt, res.headers));
      continue;
    }
    const detail = errorDetail(await res.text().catch(() => ""));
    throw new Error(`Anthropic Messages ${res.status}${detail}`);
  }
}

const isAnthropicEffort = (effort: string): effort is AnthropicEffort =>
  (ANTHROPIC_EFFORTS as readonly string[]).includes(effort);

function anthropicEffort(effort: ReasoningEffort | undefined): AnthropicEffort {
  if (effort === undefined) return "medium";
  if (isAnthropicEffort(effort)) return effort;
  throw new RangeError(
    `reasoningEffort "${effort}" has no Anthropic equivalent; use one of ${ANTHROPIC_EFFORTS.join(", ")}.`,
  );
}

/**
 * A CuaProvider backed by the Anthropic Messages API and the computer_toolset_20260801 toolset.
 * Each request carries the whole conversation (the API keeps none); the provider answers every
 * member call of a reply, halts a batch at its first failed action as the toolset documents, and
 * asks again once when a reply is cut off at its output limit. nextTurn returns only a CuaTurn:
 * the key, the request body, the screenshot and the raw reply are never returned or logged.
 */
export function createAnthropicMessagesProvider(
  options: AnthropicMessagesProviderOptions,
): CuaProvider {
  if (options.maxOutputTokens !== undefined && !isMaxOutputTokens(options.maxOutputTokens)) {
    throw new Error("maxOutputTokens must be a positive safe integer.");
  }
  const model = options.model ?? DEFAULT_ANTHROPIC_CU_MODEL;
  const effort = anthropicEffort(options.reasoningEffort);
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const retries = options.singleDispatch === true ? 0 : (options.maxRetries ?? 3);
  const conversation = new AnthropicConversation({ model, effort, maxOutputTokens });
  let lostUsage = false;
  const transport: MessagesTransport = {
    endpoint: options.endpoint ?? ANTHROPIC_MESSAGES_URL,
    apiKey: options.apiKey,
    fetchFn: options.fetchFn ?? defaultFetch(),
    delayFn: options.delayFn ?? defaultDelay,
    capture: createWireCapture(wireCaptureDir(options.env ?? process.env)),
    markUsageIncomplete: () => {
      lostUsage = true;
    },
  };

  const nextTurn = async (
    req: CuaTurnRequest,
    signal: AbortSignal,
    spend?: CuaSpendGate,
  ): Promise<CuaTurn> => {
    const request = conversation.request(req);
    const reply = await postMessages(transport, request.body, signal, {
      retries,
      interaction: true,
      spend,
    });
    return transport.capture.record(request.accept(reply), forCapture(reply));
  };

  // A closing request is posted once, with no retries; the loop decides on a second one.
  const requestClosing = async (
    req: CuaTurnRequest,
    signal: AbortSignal,
    closing: ClosingRequest,
  ): Promise<CuaTurn> => {
    let reply: unknown;
    const turn = await conversation.close(req, closing, async (body) => {
      reply = await postMessages(transport, body, signal, { retries: 0, interaction: false });
      return reply;
    });
    return transport.capture.record(turn, forCapture(reply));
  };

  return {
    id: "anthropic-messages-cu",
    version: model,
    // What the wire carries: effort and max_tokens are sent on every request, defaults included.
    modelSettings: { reasoningEffort: effort, maxOutputTokens },
    capabilities: API_COMPUTER_USE_CAPABILITIES,
    requiresFrame: true,
    outputLimitRetry: true,
    batchFailure: "halt",
    // A lost request's worst case is unbounded: the loop books it at the last reported input, and
    // the request it lost may be the one that crossed the 100,000-token tier. A capped session
    // therefore stops rather than send it again.
    requireReportedUsageForSpendCap: true,
    get interactionUsageIncomplete() {
      return lostUsage || conversation.usageUnpriced;
    },
    get conversation(): ActorConversation {
      return conversation.record();
    },
    nextTurn,
    debrief: (req, signal) => requestClosing(req, signal, "report"),
    requestImpressions: (req, signal) => requestClosing(req, signal, "impressions"),
  };
}
