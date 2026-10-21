// The Gemini API generateContent wire format of one analysis request
// (ai.google.dev/api/generate-content, read 2026-10-21): what the request body says and how a
// response becomes an AnalysisProviderResult. provider.ts owns the transport around it.

import { isRecord } from "../run/type-guards.js";
import { INPUT_IMAGE_DATA_URL } from "./image-tokens.js";
import type { AnalysisProviderResult, AnalysisTokenUsage, AnalysisWire } from "./provider.js";

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1e12;

/**
 * The response schema as Gemini accepts it. Gemini refuses the analysis schemas with a 400 while
 * they carry `maxItems`: its constrained decoder counts the states each nested array limit adds,
 * and its structured-output guide names large nested `maxItems` as a cause of that refusal. The
 * limits still hold, because validation.ts checks every response against the full schema.
 */
function geminiResponseSchema(schema: unknown, inProperties = false): unknown {
  if (Array.isArray(schema)) return schema.map((item) => geminiResponseSchema(item));
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      // Under `properties` a key is a field name, which may be any word, `maxItems` included.
      .filter(([key]) => inProperties || key !== "maxItems")
      .map(([key, value]) => [
        key,
        geminiResponseSchema(value, !inProperties && key === "properties"),
      ]),
  );
}

/**
 * Proto3 JSON leaves out a count that is zero, so an absent thoughts, candidates or cached count is
 * 0. promptTokenCount is never zero for a request that carries evidence, so it must be present.
 * Thoughts bill as output (ai.google.dev/gemini-api/docs/pricing: "Output price (including
 * thinking tokens)"). totalTokenCount must equal the parts, or none of them is trusted.
 */
function usageOf(raw: unknown): AnalysisTokenUsage | null {
  const usage = record(record(raw).usageMetadata);
  const counted = (key: string): number | null => {
    const value = usage[key] ?? 0;
    return count(value) ? value : null;
  };
  const prompt = usage.promptTokenCount;
  const toolPrompt = counted("toolUsePromptTokenCount");
  const candidates = counted("candidatesTokenCount");
  const thoughts = counted("thoughtsTokenCount");
  const cached = counted("cachedContentTokenCount");
  if (
    !count(prompt) ||
    toolPrompt === null ||
    candidates === null ||
    thoughts === null ||
    cached === null
  )
    return null;
  const input = prompt + toolPrompt;
  const output = candidates + thoughts;
  if (
    cached > input ||
    (usage.totalTokenCount !== undefined && usage.totalTokenCount !== input + output)
  )
    return null;
  return { input, output, ...(cached > 0 ? { cachedInput: cached } : {}) };
}

/** The finish reasons that end a candidate without a usable answer, by what they mean. The
 * provider declined to answer: its safety, recitation, language, blocklist or policy filters. */
const DECLINED = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "ESCALATION",
  "PUP_LIMITED_DISABLED",
]);
/** The answer stopped at the output limit, or at a long-decode hop this one request never
 * follows. */
const CUT_OFF = new Set(["MAX_TOKENS", "CONTINUATION"]);

/** One candidate whose only non-thought part is the JSON answer; anything else fails closed. */
function parseGenerateContent(raw: unknown): AnalysisProviderResult {
  const root = record(raw);
  const base = { output: null, usage: usageOf(raw), dispatched: true };
  if (record(root.promptFeedback).blockReason !== undefined)
    return { ...base, status: "refused", errorCode: "refusal" };
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  if (candidates.length !== 1) return { ...base, status: "failed", errorCode: "invalid_response" };
  const candidate = record(candidates[0]);
  const reason = String(candidate.finishReason);
  if (DECLINED.has(reason)) return { ...base, status: "refused", errorCode: "refusal" };
  if (CUT_OFF.has(reason)) return { ...base, status: "incomplete", errorCode: "output_incomplete" };
  const parts = record(candidate.content).parts;
  // A thought summary is never part of the answer; thoughtSignature on a text part is metadata.
  const answer = Array.isArray(parts) ? parts.filter((part) => record(part).thought !== true) : [];
  const text = record(answer[0]).text;
  if (
    reason !== "STOP" ||
    answer.length !== 1 ||
    typeof text !== "string" ||
    Object.keys(record(answer[0])).some((key) => key !== "text" && key !== "thoughtSignature")
  )
    return { ...base, status: "failed", errorCode: "invalid_response" };
  try {
    return { ...base, status: "completed", output: JSON.parse(text) as unknown, errorCode: null };
  } catch {
    return { ...base, status: "failed", errorCode: "invalid_response" };
  }
}

/**
 * One stateless request: no tools, high thinking, JSON constrained to the schema, the standard
 * service tier, and `store: false` so the request stays out of the project's request logs. Each
 * capture goes at MEDIA_RESOLUTION_HIGH, the setting the media-resolution guide recommends for
 * image analysis, after a text part naming its evidence key.
 */
export const geminiWire: AnalysisWire = {
  url: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  headers: (apiKey) => ({ "x-goog-api-key": apiKey, "Content-Type": "application/json" }),
  body: (request) => ({
    systemInstruction: { parts: [{ text: request.instructions }] },
    contents: [
      {
        // The API leaves role optional outside a multi-turn conversation.
        parts: [
          { text: request.evidence },
          ...request.images.flatMap((image) => {
            const [, type, data] = INPUT_IMAGE_DATA_URL.exec(image.dataUrl)!;
            return [
              { text: JSON.stringify({ captureEvidenceId: image.evidenceId }) },
              {
                inlineData: { mimeType: `image/${type}`, data },
                mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" },
              },
            ];
          }),
        ],
      },
    ],
    generationConfig: {
      candidateCount: 1,
      maxOutputTokens: request.maxOutputTokens,
      thinkingConfig: { thinkingLevel: "HIGH" },
      responseFormat: {
        text: { mimeType: "APPLICATION_JSON", schema: geminiResponseSchema(request.schema) },
      },
    },
    serviceTier: "standard",
    store: false,
  }),
  parse: parseGenerateContent,
};
