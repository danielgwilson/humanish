/** Deliberately separate from the stateful computer-use actor: one request, no tools or retries. */
export interface StudyAnalysisProviderRequest {
  model: string;
  instructions: string;
  evidence: string;
  images: { evidenceId: string; dataUrl: string }[];
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface StudyAnalysisTokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWriteInput?: number;
}

export interface StudyAnalysisProviderResult {
  status: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "timed_out";
  /** Parsed output is still untrusted. The engine must validate its schema and evidence references. */
  output: unknown;
  usage: StudyAnalysisTokenUsage | null;
  /** Dispatch does not imply a known charge. A failed request can still have consumed tokens. */
  dispatched: boolean;
  errorCode: "invalid_request" | "provider_http_error" | "provider_network_error" | "invalid_response"
    | "response_too_large" | "output_incomplete" | "refusal" | "cancelled" | "timeout" | null;
  httpStatus?: number;
}

export type StudyAnalysisProvider = (request: StudyAnalysisProviderRequest) => Promise<StudyAnalysisProviderResult>;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const INPUT_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1e12;

function usageOf(raw: unknown): StudyAnalysisTokenUsage | null {
  const usage = record(record(raw).usage);
  const details = record(usage.input_tokens_details);
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cachedInput = details.cached_tokens;
  const cacheWriteInput = details.cache_write_tokens;
  if (!count(input) || !count(output)
    || (cachedInput !== undefined && !count(cachedInput))
    || (cacheWriteInput !== undefined && !count(cacheWriteInput))
    || ((cachedInput as number | undefined) ?? 0) + ((cacheWriteInput as number | undefined) ?? 0) > input) return null;
  return { input, output,
    ...(cachedInput === undefined ? {} : { cachedInput: cachedInput as number }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput: cacheWriteInput as number }) };
}

/** Text and usage wire shapes reuse the captured closing-report contract; refusal fails closed. */
export function parseStudyAnalysisResponse(raw: unknown): StudyAnalysisProviderResult {
  const root = record(raw);
  const usage = usageOf(raw);
  const output = Array.isArray(root.output) ? root.output : [];
  const contents = output.filter(item => record(item).type === "message")
    .flatMap(item => Array.isArray(record(item).content) ? record(item).content as unknown[] : []);
  const base = { output: null, usage, dispatched: true };
  if (contents.some(item => record(item).type === "refusal")) {
    return { ...base, status: "refused", errorCode: "refusal" };
  }
  if (root.status === "incomplete") return { ...base, status: "incomplete", errorCode: "output_incomplete" };
  if (root.status !== "completed" || output.some(item => !["message", "reasoning"].includes(String(record(item).type)))) {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
  // A single JSON answer is expected. Do not concatenate multiple answer objects or expose a
  // refusal, reasoning item, or incomplete message as the report's prose.
  const messages = output.filter(item => record(item).type === "message");
  const texts = contents.filter(item => record(item).type === "output_text");
  if (messages.length !== 1 || record(messages[0]).status !== "completed" || record(messages[0]).role !== "assistant" || texts.length !== 1
    || contents.length !== 1 || typeof record(texts[0]).text !== "string") {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
  try {
    return { ...base, status: "completed", output: JSON.parse(record(texts[0]).text as string) as unknown, errorCode: null };
  } catch {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
}

/** No alternate endpoint or env-derived base URL: evidence and credentials have one destination. */
export function createStudyAnalysisProvider(options: {
  apiKey: string;
  fetchFn?: typeof fetch;
}): StudyAnalysisProvider {
  const fetchFn = options.fetchFn ?? fetch;
  return async request => {
    const failure = (errorCode: StudyAnalysisProviderResult["errorCode"], dispatched: boolean,
      status: StudyAnalysisProviderResult["status"] = "failed"): StudyAnalysisProviderResult =>
      ({ status, output: null, usage: null, dispatched, errorCode });
    if (request.signal?.aborted) return failure("cancelled", false, "cancelled");
    if (!options.apiKey.trim() || !/^[A-Za-z0-9_.-]{1,100}$/.test(request.model)
      || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 256 || request.maxOutputTokens > 32_768
      || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000
      || request.images.length > 128 || request.images.some(image => !INPUT_IMAGE.test(image.dataUrl))) {
      return failure("invalid_request", false);
    }
    const content = [
      { type: "input_text", text: request.evidence },
      ...request.images.flatMap(image => [
        { type: "input_text", text: JSON.stringify({ captureEvidenceId: image.evidenceId }) },
        { type: "input_image", image_url: image.dataUrl, detail: "high" }
      ])
    ];
    const body = JSON.stringify({ model: request.model, instructions: request.instructions,
      input: [{ role: "user", content }], store: false, tools: [], tool_choice: "none",
      truncation: "disabled", service_tier: "default", max_output_tokens: request.maxOutputTokens,
      text: { format: { type: "json_schema", name: "study_analysis", strict: true, schema: request.schema } } });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return failure("invalid_request", false);
    const controller = new AbortController();
    let timedOut = false;
    let dispatched = false;
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
    try {
      if (request.signal?.aborted) return failure("cancelled", false, "cancelled");
      dispatched = true;
      const response = await fetchFn("https://api.openai.com/v1/responses", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, body
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
      if (controller.signal.aborted) return failure(timedOut ? "timeout" : "cancelled", true, timedOut ? "timed_out" : "cancelled");
      try {
        return parseStudyAnalysisResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        return failure("invalid_response", true);
      }
    } catch {
      if (controller.signal.aborted) return failure(timedOut ? "timeout" : "cancelled", dispatched, timedOut ? "timed_out" : "cancelled");
      return failure("provider_network_error", dispatched);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  };
}
