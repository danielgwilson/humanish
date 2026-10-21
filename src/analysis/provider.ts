// The analysis provider seam and the HTTP transport its API adapters share. Each API vendor owns
// only its wire format (gemini-wire.ts, openai-wire.ts): the endpoint, the request body, and how a
// response becomes a result. The transport owns what must hold for every vendor: one fixed endpoint
// per vendor, request and response byte caps, the caller's wall-clock deadline, no retry, and a
// closed error vocabulary that never carries provider error prose. The Codex account analyst is
// the third adapter at the same seam (restricted-codex.ts).

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { isRecord } from "../run/type-guards.js";
import { INPUT_IMAGE_DATA_URL } from "./image-tokens.js";
import { geminiWire } from "./gemini-wire.js";
import { openaiWire } from "./openai-wire.js";

/** Deliberately separate from the stateful computer-use actor: one request, no tools or retries. */
export interface AnalysisProviderRequest {
  model: string;
  instructions: string;
  evidence: string;
  images: { evidenceId: string; dataUrl: string }[];
  schema: Record<string, unknown>;
  maxOutputTokens: number | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AnalysisTokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWriteInput?: number;
}

export interface AnalysisProviderResult {
  status: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "timed_out";
  /** Parsed output is still untrusted. runAnalysis must validate its schema and evidence references. */
  output: unknown;
  usage: AnalysisTokenUsage | null;
  /** Dispatch does not imply a known charge. A failed request can still have consumed tokens. */
  dispatched: boolean;
  /** Omitted preserves complete API-response accounting; account snapshots must state this. */
  usageComplete?: boolean;
  errorCode:
    | "invalid_request"
    | "provider_http_error"
    | "provider_network_error"
    | "invalid_response"
    | "provider_headers_timeout"
    | "provider_client_timeout"
    | "provider_body_timeout"
    | "provider_connect_timeout"
    | "provider_connection_reset"
    | "provider_dns_error"
    | "codex_busy"
    | "codex_unavailable"
    | "codex_unsupported_version"
    | "codex_incompatible_release"
    | "codex_unsupported_platform"
    | "codex_login_required"
    | "codex_unsupported_auth"
    | "codex_unsafe_configuration"
    | "codex_model_unavailable"
    | "codex_protocol_error"
    | "codex_tool_call"
    | "codex_process_failed"
    | "codex_cleanup_failed"
    | "response_too_large"
    | "output_incomplete"
    | "refusal"
    | "cancelled"
    | "timeout"
    | null;
  httpStatus?: number;
  /** Codex only: notification methods humanish does not know that carried no item, by count. */
  unknownNotifications?: Readonly<Record<string, number>>;
  /** Codex only: bytes of a last frame cut off when humanish stopped the app-server. */
  truncatedFrameBytes?: number;
  /** Codex only: how the release's app-server schema differs from the fields humanish reads. */
  protocolIncompatibilities?: readonly string[];
  /** Codex only: schema values beyond the baseline humanish knows. */
  protocolAdditions?: readonly string[];
}

export type AnalysisProvider = (
  request: AnalysisProviderRequest,
) => Promise<AnalysisProviderResult>;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** Undici's fetch has a separate response-header deadline. The caller's wall-clock
 * deadline must govern this one request, including uploads and body reads, without
 * changing transport behavior for other requests in the process. The agent is used with
 * fetch from the same undici package: Node's built-in fetch bundles its own undici, and an
 * undici 8 agent fails there with "invalid onRequestStart method". */
class AnalysisAgent extends Agent {
  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    return super.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
  }
}

/** Persist only a closed vocabulary, never an exception's prose, URL or headers. */
function networkErrorCode(error: unknown): AnalysisProviderResult["errorCode"] {
  const codes: Record<string, AnalysisProviderResult["errorCode"]> = {
    UND_ERR_HEADERS_TIMEOUT: "provider_headers_timeout",
    UND_ERR_BODY_TIMEOUT: "provider_body_timeout",
    UND_ERR_CONNECT_TIMEOUT: "provider_connect_timeout",
    ECONNRESET: "provider_connection_reset",
    UND_ERR_SOCKET: "provider_connection_reset",
    ENOTFOUND: "provider_dns_error",
    EAI_AGAIN: "provider_dns_error",
  };
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const value = record(current);
    if (typeof value.code === "string" && Object.hasOwn(codes, value.code))
      return codes[value.code]!;
    // Bun's fetch ends a request with a TimeoutError of its own, with no code.
    if (value.name === "TimeoutError") return "provider_client_timeout";
    current = value.cause;
  }
  return "provider_network_error";
}

/** The part of fetch this provider uses; undici's fetch and test doubles both satisfy it. */
export type AnalysisFetch = (
  url: string,
  init: {
    method: "POST";
    redirect: "error";
    signal: AbortSignal;
    headers: Record<string, string>;
    body: string;
    dispatcher: Dispatcher;
    /**
     * Bun's fetch ignores `dispatcher` and ends a request after 300 s unless this is false;
     * Node's undici fetch ignores the field. The caller's timeoutMs governs either way.
     */
    timeout: false;
  },
) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;

/** The analysts humanish calls over HTTP with an API key. Codex runs through its own CLI. */
export type AnalysisApiVendor = "openai" | "gemini";

/** One vendor's wire format. The transport sends `body` to `url` with `headers` and gives `parse`
 * the response JSON only after a 2xx status, within the byte cap and the deadline. */
export interface AnalysisWire {
  /** A fixed endpoint: never derived from env, so evidence and credentials have one destination. */
  url(model: string): string;
  headers(apiKey: string): Record<string, string>;
  body(request: AnalysisProviderRequest): unknown;
  parse(raw: unknown): AnalysisProviderResult;
}

const WIRES: Readonly<Record<AnalysisApiVendor, AnalysisWire>> = {
  openai: openaiWire,
  gemini: geminiWire,
};

/** One request to the vendor's fixed endpoint, never retried and never sent elsewhere. */
export function createAnalysisProvider(options: {
  apiKey: string;
  /** Omitted is OpenAI, the analyst humanish has always called. */
  vendor?: AnalysisApiVendor;
  fetchFn?: AnalysisFetch;
}): AnalysisProvider {
  const fetchFn = options.fetchFn ?? undiciFetch;
  const wire = WIRES[options.vendor ?? "openai"];
  return async (request) => {
    const failure = (
      errorCode: AnalysisProviderResult["errorCode"],
      dispatched: boolean,
      status: AnalysisProviderResult["status"] = "failed",
    ): AnalysisProviderResult => ({
      status,
      output: null,
      usage: null,
      dispatched,
      errorCode,
    });
    if (request.signal?.aborted) return failure("cancelled", false, "cancelled");
    if (
      !options.apiKey.trim() ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(request.model) ||
      request.maxOutputTokens === null ||
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 256 ||
      request.maxOutputTokens > 32_768 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 600_000 ||
      request.images.length > 128 ||
      request.images.some((image) => !INPUT_IMAGE_DATA_URL.test(image.dataUrl))
    ) {
      return failure("invalid_request", false);
    }
    const body = JSON.stringify(wire.body(request));
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return failure("invalid_request", false);
    const controller = new AbortController();
    let timedOut = false;
    let dispatched = false;
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    const dispatcher = new AnalysisAgent();
    try {
      if (request.signal?.aborted) return failure("cancelled", false, "cancelled");
      dispatched = true;
      const response = await fetchFn(wire.url(request.model), {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: wire.headers(options.apiKey),
        body,
        dispatcher,
        timeout: false,
      });
      if (!response.ok) {
        // Never read provider error prose: it may echo evidence or credentials.
        await response.body?.cancel();
        return { ...failure("provider_http_error", true), httpStatus: response.status };
      }
      if (!response.body) return failure("invalid_response", true);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return failure("response_too_large", true);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (controller.signal.aborted)
        return failure(
          timedOut ? "timeout" : "cancelled",
          true,
          timedOut ? "timed_out" : "cancelled",
        );
      try {
        return wire.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        return failure("invalid_response", true);
      }
    } catch (error) {
      if (controller.signal.aborted)
        return failure(
          timedOut ? "timeout" : "cancelled",
          dispatched,
          timedOut ? "timed_out" : "cancelled",
        );
      return failure(networkErrorCode(error), dispatched);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      // Under Bun, `undici` is Bun's built-in module, whose Agent has no destroy(). Closing the
      // agent must never replace the request's result, so a teardown that throws is ignored.
      try {
        await dispatcher.destroy();
      } catch {
        // The agent belongs to this request alone; nothing else uses it after this point.
      }
    }
  };
}
