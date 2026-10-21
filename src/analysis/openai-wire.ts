// The OpenAI Responses API wire format of one analysis request: what the request body says and how
// a response becomes an AnalysisProviderResult. provider.ts owns the transport around it.

import { OPENAI_RESPONSES_URL } from "../actors/openai-endpoint.js";
import { isRecord } from "../run/type-guards.js";
import type { AnalysisProviderResult, AnalysisTokenUsage, AnalysisWire } from "./provider.js";

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1e12;

function usageOf(raw: unknown): AnalysisTokenUsage | null {
  const usage = record(record(raw).usage);
  const details = record(usage.input_tokens_details);
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cachedInput = details.cached_tokens;
  const cacheWriteInput = details.cache_write_tokens;
  if (
    !count(input) ||
    !count(output) ||
    (cachedInput !== undefined && !count(cachedInput)) ||
    (cacheWriteInput !== undefined && !count(cacheWriteInput)) ||
    ((cachedInput as number | undefined) ?? 0) + ((cacheWriteInput as number | undefined) ?? 0) >
      input
  )
    return null;
  return {
    input,
    output,
    ...(cachedInput === undefined ? {} : { cachedInput: cachedInput as number }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput: cacheWriteInput as number }),
  };
}

/** Text and usage wire shapes reuse the captured closing-report contract; refusal fails closed. */
export function parseAnalysisResponse(raw: unknown): AnalysisProviderResult {
  const root = record(raw);
  const usage = usageOf(raw);
  const output = Array.isArray(root.output) ? root.output : [];
  const contents = output
    .filter((item) => record(item).type === "message")
    .flatMap((item) =>
      Array.isArray(record(item).content) ? (record(item).content as unknown[]) : [],
    );
  const base = { output: null, usage, dispatched: true };
  if (contents.some((item) => record(item).type === "refusal")) {
    return { ...base, status: "refused", errorCode: "refusal" };
  }
  if (root.status === "incomplete")
    return { ...base, status: "incomplete", errorCode: "output_incomplete" };
  if (
    root.status !== "completed" ||
    output.some((item) => !["message", "reasoning"].includes(String(record(item).type)))
  ) {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
  // A single JSON answer is expected. Do not concatenate multiple answer objects or expose a
  // refusal, reasoning item, or incomplete message as the report's prose.
  const messages = output.filter((item) => record(item).type === "message");
  const texts = contents.filter((item) => record(item).type === "output_text");
  if (
    messages.length !== 1 ||
    record(messages[0]).status !== "completed" ||
    record(messages[0]).role !== "assistant" ||
    texts.length !== 1 ||
    contents.length !== 1 ||
    typeof record(texts[0]).text !== "string"
  ) {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
  try {
    return {
      ...base,
      status: "completed",
      output: JSON.parse(record(texts[0]).text as string) as unknown,
      errorCode: null,
    };
  } catch {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
}

/** One stateless request: no stored response, no tools, high reasoning effort, strict schema. */
export const openaiWire: AnalysisWire = {
  url: () => OPENAI_RESPONSES_URL,
  headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }),
  body: (request) => ({
    model: request.model,
    instructions: request.instructions,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: request.evidence },
          ...request.images.flatMap((image) => [
            { type: "input_text", text: JSON.stringify({ captureEvidenceId: image.evidenceId }) },
            { type: "input_image", image_url: image.dataUrl, detail: "high" },
          ]),
        ],
      },
    ],
    store: false,
    tools: [],
    tool_choice: "none",
    truncation: "disabled",
    service_tier: "default",
    reasoning: { effort: "high" },
    max_output_tokens: request.maxOutputTokens,
    text: {
      format: { type: "json_schema", name: "study_analysis", strict: true, schema: request.schema },
    },
  }),
  parse: parseAnalysisResponse,
};
