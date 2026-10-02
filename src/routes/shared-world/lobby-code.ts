// Reads a lobby code (the /lobby/CODE path segment) from a URL, from a seat's narration or, through
// a vision model call, from a seat's screenshot. The external-public plane uses it to hand the
// host's lobby to the followers.

import { OPENAI_RESPONSES_URL } from "../../actors/openai-endpoint.js";

/**
 * The lobby-trivia (and general "/lobby/CODE") shared-session URL matcher. A code is exactly 6 chars of
 * the [A-Z2-9] class; a locale prefix (/en/lobby/…) and a query/hash suffix are tolerated. Runtime-only
 * input (a live location.href); only the extracted code is used, and it lands only as a digest.
 */
const LOBBY_CODE_PATTERN = /\/lobby\/([A-Z2-9]{6})(?:$|[/?#])/;

/** Extract the shared-session code from a (runtime-only) observed URL, or undefined. Exported for the
 *  handoff regex table test. Pure, no side effects, never persists its input. */
export function extractLobbyCode(url: string | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(LOBBY_CODE_PATTERN);
  return match ? match[1] : undefined;
}

/**
 * Extract a lobby code from free-form actor narration (the host's reasoning/message where it states
 * the lobby URL it sees), where the /lobby/CODE is followed by arbitrary prose (a space, backtick,
 * newline) rather than end-of-string or /?#, so the strict LOBBY_CODE_PATTERN would miss it. Uses a
 * negative-lookahead boundary (exactly 6 code chars). This is the CDP-independent handoff path: the
 * host reads the code on screen and states it, and this reads it from the model's own text. Pure;
 * input is runtime-only; only the code is used (as a digest).
 */
const LOBBY_CODE_IN_TEXT = /\/lobby\/([A-Z2-9]{6})(?![A-Z2-9])/;

export function extractLobbyCodeFromNarration(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const inUrl = text.match(LOBBY_CODE_IN_TEXT);
  if (inUrl) return inUrl[1];
  // Fallback: an explicitly-labeled bare code (e.g. "LOBBY_CODE=ABC123"), which the host may state
  // if it copied the code rather than the URL. The label is matched case-insensitively, but the code
  // itself must be uppercase [A-Z2-9]: a real lobby code always renders uppercase, whereas an /i match
  // on the code class would also grab an ordinary lowercase word after "lobby code " (e.g. "the lobby
  // code screen") and latch a wrong code. Precision-first, matching parseLobbyCodeReply's rationale.
  const labeled = text.match(/lobby[ _-]?code[=:\s]+([A-Z2-9]{6})(?![A-Za-z2-9])/i);
  return labeled && labeled[1] && /^[A-Z2-9]{6}$/.test(labeled[1]) ? labeled[1] : undefined;
}

/** Pull the assistant's plain text out of an OpenAI Responses API body (`output_text` convenience
 *  field, else the concatenated `output[].content[].text`). Tolerant of shape drift; pure. */
export function extractResponsesOutputText(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.output_text === "string" && obj.output_text.length > 0) return obj.output_text;
  const out = obj.output;
  if (!Array.isArray(out)) return undefined;
  const parts: string[] = [];
  for (const item of out) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        typeof (chunk as Record<string, unknown>).text === "string"
      ) {
        parts.push((chunk as Record<string, unknown>).text as string);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Parse a vision reply into a lobby code. Precision-first: accept only when the whole reply is the
 *  six-character code, or when it echoes an explicit /lobby/CODE; never a bare 6-letter token buried in
 *  prose (e.g. "I see a home `SCREEN`"), because a wrong latch fails the entire run, whereas a miss just
 *  retries on the next frame while the host keeps waiting. `NONE` (the instructed "no code" reply) is
 *  rejected. Pure. */
export function parseLobbyCodeReply(reply: string | undefined): string | undefined {
  if (typeof reply !== "string") return undefined;
  const up = reply.trim().toUpperCase();
  if (up.length === 0 || /\bNONE\b/.test(up)) return undefined;
  if (/^[A-Z2-9]{6}$/.test(up)) return up; // the well-behaved "code only" reply
  const inUrl = up.match(/\/LOBBY\/([A-Z2-9]{6})(?![A-Z2-9])/); // model echoed the invite link
  return inUrl ? inUrl[1] : undefined;
}

const LOBBY_CODE_VISION_PROMPT =
  "This is a screenshot of a the example multiplayer app multiplayer lobby. If a waiting-room / invite screen is " +
  "shown, read the 6-character lobby code (characters A-Z and 2-9 only) — it appears near a 'lobby " +
  "code'/'room code' label or inside an invite link of the form /lobby/CODE. Your entire reply MUST be " +
  "exactly those 6 characters in uppercase and NOTHING else (no words, no punctuation). If no lobby " +
  "code is visible on this screen (e.g. it is the home screen or a game round), reply exactly NONE.";

// A single-frame OCR-style read. gpt-5.5 (the computer-use default) is used deliberately: it reliably reads the
// 6-char code off a dense mobile-viewport waiting room. A smaller/cheaper model (gpt-4.1-mini) was
// tried and could not read it. reasoning.effort stays "low" (minimal) and the output budget is small
// but comfortably clear of the "incomplete on reasoning overflow" edge. Kept on the same account/key
// as the actor; the same full-fidelity frame is already sent to this API by the computer-use provider, so this
// adds no new data-exposure surface. See onScreenshot in runHost.
const LOBBY_CODE_VISION_MODEL = "gpt-5.5";

// Output-token budget for the read. The answer is 6 chars, but leave clear margin over any low-effort
// reasoning tokens so the response never comes back status:"incomplete" with empty output.
const LOBBY_CODE_VISION_MAX_OUTPUT_TOKENS = 64;

// Per-read wall-clock cap. Without it a stalled fetch (Node fetch has no default timeout) would leave
// visionInFlight pinned true and silently kill the relay for the rest of the host run.
const LOBBY_CODE_VISION_TIMEOUT_MS = 15_000;

export interface ReadLobbyCodeOptions {
  model?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Vision-read a lobby code straight off a host waiting-room frame (the robust, CDP-independent handoff
 * relay). Fail-soft: any network/HTTP/parse problem returns undefined so the caller simply retries on
 * the next frame. The frame is runtime-only; only the extracted code is used (as a digest downstream).
 */
export async function readLobbyCodeFromFrame(
  frame: Buffer,
  apiKey: string,
  options: ReadLobbyCodeOptions = {},
): Promise<string | undefined> {
  if (typeof apiKey !== "string" || apiKey.length === 0 || frame.length === 0) return undefined;
  const fetchFn = options.fetchFn ?? fetch;
  // Default a wall-clock timeout so a stalled request can't wedge the caller's in-flight guard. An
  // explicit signal (e.g. run abort) takes precedence when provided.
  const signal = options.signal ?? AbortSignal.timeout(LOBBY_CODE_VISION_TIMEOUT_MS);
  const body = {
    model: options.model ?? LOBBY_CODE_VISION_MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: LOBBY_CODE_VISION_MAX_OUTPUT_TOKENS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: LOBBY_CODE_VISION_PROMPT },
          { type: "input_image", image_url: `data:image/png;base64,${frame.toString("base64")}` },
        ],
      },
    ],
  };
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(options.endpoint ?? OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return undefined; // transient network error: skip this frame, next turn retries
  }
  if (!res.ok) return undefined; // never read a non-ok body (it can echo the frame/input)
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return undefined;
  }
  return parseLobbyCodeReply(extractResponsesOutputText(parsed));
}
