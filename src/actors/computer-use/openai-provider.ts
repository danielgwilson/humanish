import { validClosingReport } from "./loop.js";
import type { ActorCapabilities, ActorConversation } from "../contract.js";
import {
  ComputerUseAdmissionLimitError,
  isComputerUseAdmissionLimitError,
} from "./admission-limit.js";
import { ComputerUsePromptRefusedError } from "./provider-error.js";
import type { CuaProvider, CuaSpendGate, CuaTurn, CuaTurnRequest } from "./loop.js";
import { CarriedConversation } from "./openai-context.js";
import {
  acceptReply,
  ConversationRecord,
  debriefRequestBody,
  turnInputItems,
  turnRequestBody,
  type OpenAiConversationState,
  type OpenAiRequestSettings,
} from "./openai-requests.js";
import {
  asRecord,
  optionalString,
  parseOpenAiResponse,
  type OpenAiReasoningSummary,
} from "./openai-wire.js";
import { redactText } from "../../evidence/redaction.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import { isMaxOutputTokens } from "../output-token-limit.js";
import {
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/contained-output.js";
import { OPENAI_RESPONSES_URL } from "../openai-endpoint.js";

// A public-safe re-derivation of the OpenAI Responses API computer-use provider,
// behind the CuaProvider port from src/actors/computer-use/loop.ts. The pure wire mapping
// (openAiActionToCua, parseOpenAiResponse and the request builders) is in openai-wire.ts.
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
// Wire capture (fixture provenance). In the 0.6.1 parser incident, the parser read
// `computer_call.action` (singular) while the live API returns `actions` (array),
// and the hand-written fixtures encoded the same wrong shape, so tests passed in
// lockstep with the bug while every live action was silently dropped. It taught us
// that deterministic fixtures must derive from captured live wire shapes, never
// from memory. Setting HUMANISH_CUA_WIRE_CAPTURE_DIR makes the live shim persist
// each successful Responses response body into that directory as pretty-printed
// JSON, one file per provider call in call order (wire-001.json, wire-002.json,
// ...), for refreshing fixtures. The capture seam is:
//  - Opt-in: unset (or empty) env means zero behavior change, and nothing is written;
//  - Response-side only: request bodies carry base64 screenshots and the persona
//    instructions and are never captured; non-ok response bodies can echo the
//    request and are never captured either;
//  - Redacted: every string field (keys and values) passes through the shared
//    redactText (src/evidence/redaction.ts) before writing, so a secret-shaped echo in a
//    response cannot persist to disk.
// Point the env var at a gitignored path (e.g. under .humanish/): raw captures must
// never be committed; fixtures derived from them must be minimal, hand-reviewed
// excerpts checked into tests deliberately.

export const OPENAI_RESPONSES_CU_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "proprietary",
};

// The flagship 5.6-generation tier ("gpt-5.6" is OpenAI's alias for this exact id; the
// computer-use guide's own examples run on it). Explicit tier id so trace provenance and the
// rate-table key stay stable if OpenAI repoints the alias.
export const DEFAULT_OPENAI_CU_MODEL = "gpt-5.6-sol";

/**
 * The effort a request carries when a study declares none. Exported because a default that only
 * exists as a literal inside the provider is exactly how it stayed invisible: the study surface has
 * to be able to say what will actually run.
 */
export const DEFAULT_OPENAI_CU_REASONING_EFFORT: ReasoningEffort = "medium";

// ---------------------------------------------------------------------------
// Wire capture (see the module header). Pure helpers, exported for unit tests.
// ---------------------------------------------------------------------------

/** The opt-in gate for response wire capture: a directory path, or unset for off. */
export const WIRE_CAPTURE_ENV = "HUMANISH_CUA_WIRE_CAPTURE_DIR";

/**
 * Deep-copy a captured wire value with every string (object keys included)
 * passed through the shared redactText, so a secret-shaped echo in a response
 * can never persist to disk. Pure; non-string primitives pass through unchanged.
 */
export function redactWireJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactWireJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        redactText(key),
        redactWireJson(entry),
      ]),
    );
  }
  return value;
}

/** Deterministic ordered capture file name for the 1-based nth provider call. */
export function wireCaptureFileName(callNumber: number): string {
  return `wire-${String(callNumber).padStart(3, "0")}.json`;
}

// ---------------------------------------------------------------------------
// Live shim: a stateful CuaProvider over a raw POST to the Responses endpoint.
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the fetch contract the shim depends on. Injecting this
 * (rather than importing a fetch type) keeps the module dependency-free and lets
 * CI tests run with a fake that never touches the network.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Optional so a scripted fake need not carry headers; the real fetch Response does. */
  headers?: { get(name: string): string | null };
}>;

/** The longest wait a provider's Retry-After hint can impose on one retry. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Parse a Retry-After header (delay-seconds or an HTTP-date) into milliseconds from `now`;
 * undefined when absent or unreadable. OpenAI's 2026-09-02 change added `429 slow_down` and
 * `503 server_is_overloaded`, both of which may carry it; a fixed 200/400/800 ms backoff against
 * a 20 s hint burns every retry inside the hint and ends the participant's session for nothing.
 */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

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
   * Environment for the wire-capture gate (HUMANISH_CUA_WIRE_CAPTURE_DIR; see the
   * module header). Injectable so deterministic tests control the gate without
   * mutating process.env. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
}

/** Which answer told the provider that the organization keeps no server-side conversation. */
type ZdrRejection = NonNullable<ActorConversation["rejection"]>;

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

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      json: () => res.json() as Promise<unknown>,
    };
  };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Response wire capture for one provider: prepares each file before dispatch, then writes it. */
interface WireCapture {
  /** Preflight the next capture file; undefined when capture is off. */
  prepareNext(): Promise<PreparedSelectedOutputDirectory | undefined>;
  /** Persist one successful response body, redacted and pretty-printed. */
  record(raw: unknown): Promise<void>;
}

// Opt-in response wire capture (see module header): an undefined directory means off and zero
// behavior change. The counter is per-provider, so file order is call order.
function createWireCapture(captureDir: string | undefined): WireCapture {
  let captureCount = 0;
  let preparedCaptureRoot: Promise<PreparedSelectedOutputDirectory> | undefined;
  const prepareNext = async (): Promise<PreparedSelectedOutputDirectory | undefined> => {
    if (captureDir === undefined) return undefined;
    preparedCaptureRoot ??= prepareSelectedOutputDirectory(process.cwd(), captureDir);
    const captureRoot = await preparedCaptureRoot;
    await prepareContainedOutputFile(captureRoot, wireCaptureFileName(captureCount + 1));
    return captureRoot;
  };
  return {
    prepareNext,
    // Fails loud: a silent capture failure would mean missing turns in a fixture refresh: the
    // exact "fixtures drift from the wire" pathology capture exists to prevent.
    record: async (raw) => {
      if (captureDir === undefined) return;
      const captureRoot = await prepareNext();
      if (!captureRoot) return;
      captureCount += 1;
      await writeContainedOutputFile(
        captureRoot,
        wireCaptureFileName(captureCount),
        `${JSON.stringify(redactWireJson(raw), null, 2)}\n`,
        "utf8",
      );
    },
  };
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
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await transport.fetchFn(transport.endpoint, {
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
      const parsed: unknown = await res.json();
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
      // The provider's own hint wins over the fixed backoff, up to the cap.
      const backoff = 2 ** attempt * 200;
      const hinted = retryAfterMs(res.headers?.get("retry-after"), Date.now());
      await transport.delayFn(
        hinted === undefined ? backoff : Math.min(Math.max(backoff, hinted), RETRY_AFTER_CAP_MS),
      );
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
  // An unset or empty capture variable leaves capture off.
  const capture = createWireCapture(
    optionalString((options.env ?? process.env)[WIRE_CAPTURE_ENV]?.trim()),
  );
  let interactionUsageIncomplete = false;
  const settings: OpenAiRequestSettings = {
    model,
    reasoningEffort,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(options.safetyIdentifier === undefined
      ? {}
      : { safetyIdentifier: options.safetyIdentifier }),
  };
  const state: OpenAiConversationState = {
    lastResponseId: undefined,
    pendingCallIds: [],
    replies: 0,
    conversation: new CarriedConversation(),
    mode: options.zeroDataRetention ? "explicit_context" : "previous_response_id",
    // Latches to undefined (stop asking) for the rest of the session when the
    // account/model rejects the summary request; see OpenAiResponsesProviderOptions.
    reasoningSummary:
      options.reasoningSummary === "off" ? undefined : (options.reasoningSummary ?? "auto"),
  };

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

  const record = new ConversationRecord(
    options.zeroDataRetention === true,
    options.now ?? Date.now,
  );

  // POST with the recoverable-policy latches: a ZDR rejection switches to explicit-context mode; a
  // reasoning-summary rejection latches summaries off. Each latch can flip only once, so the loop
  // is bounded; anything else rethrows. The body is rebuilt per attempt so a flipped latch shows.
  const postTurn = async (
    req: CuaTurnRequest,
    sent: readonly unknown[],
    signal: AbortSignal,
    spend: CuaSpendGate | undefined,
  ): Promise<unknown> => {
    if (options.singleDispatch === true)
      return post(turnRequestBody(settings, state, req, sent), signal, 0);
    for (;;) {
      try {
        return await post(
          turnRequestBody(settings, state, req, sent),
          signal,
          maxRetries,
          true,
          spend,
        );
      } catch (error) {
        if (error instanceof SummaryRejectionError && state.reasoningSummary !== undefined) {
          state.reasoningSummary = undefined;
          continue;
        }
        if (error instanceof ZdrError && state.mode !== "explicit_context") {
          record.switched(error.rejection);
          state.mode = "explicit_context";
          continue;
        }
        throw error;
      }
    }
  };

  const requestTurn = async (
    req: CuaTurnRequest,
    signal: AbortSignal,
    closing = false,
    spend?: CuaSpendGate,
  ): Promise<CuaTurn> => {
    await capture.prepareNext();
    const sent = turnInputItems(state, req);
    // A closing report makes exactly one request: no HTTP or policy-latch retries.
    const raw = closing
      ? await post(debriefRequestBody(settings, state, req, sent), signal, 0, false)
      : await postTurn(req, sent, signal, spend);
    if (!closing) record.requested(state, sent);
    const parsed = parseOpenAiResponse(raw);
    acceptReply(state, parsed, closing, sent);
    if (closing) {
      // Refusals, incomplete output, malformed JSON, and invalid shapes remain no-report results.
      // Never promote raw JSON or a fallback paragraph into a structured finding.
      try {
        const report: unknown = JSON.parse(parsed.turn.message ?? "");
        if (asRecord(raw).status === "completed" && validClosingReport(report)) {
          return { ...parsed.turn, closingReport: report };
        }
      } catch {
        /* A failed optional closing account keeps its usage and no report. */
      }
    }
    return parsed.turn;
  };

  return {
    id: "openai-responses-cu",
    version: model,
    // The effort the wire actually carries, not the one the study asked for: the provider defaults
    // an absent request to "medium", and the trace has to say what produced it.
    modelSettings: {
      reasoningEffort,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
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
    nextTurn: (req, signal, spend) => requestTurn(req, signal, false, spend),
    get conversation(): ActorConversation {
      return record.snapshot(state);
    },
    // An explicit-context conversation summarizes its oldest turns past its budget, so it may not
    // hold the whole session a retrospective report needs. This getter follows both configured
    // ZDR and a runtime policy latch.
    get debrief() {
      return state.mode === "explicit_context" || state.lastResponseId === undefined
        ? undefined
        : (req: CuaTurnRequest, signal: AbortSignal) => requestTurn(req, signal, true);
    },
  };
}
