import type { CuaAction, CuaSafetyCheck, CuaTurn } from "./loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";

// The OpenAI Responses computer-use wire shape, mapped to and from the provider-neutral CuaAction
// and CuaTurn types. Everything here is pure: the action mapper, the response parser and the
// request-body builders touch no network and no key, so unit tests drive them directly. The live
// client that posts these bodies is openai-provider.ts. Fixtures for this module come from
// captured live responses; the wire-capture note in openai-provider.ts says how to take them.

// ---------------------------------------------------------------------------
// Defensive readers. The Responses wire shape is loosely typed (unknown), so we
// read every field defensively: a non-object is treated as empty, a non-number
// coordinate becomes 0, and a non-string text becomes "".
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPoint(value: unknown): { x: number; y: number } {
  const point = asRecord(value);
  return { x: asNumber(point.x), y: asNumber(point.y) };
}

/** The keys a pointer action holds (`keys` on click, double_click, drag, move and scroll). */
function heldKeysOf(record: Record<string, unknown>): { heldKeys?: string[] } {
  const keys = asArray(record.keys).filter((key): key is string => typeof key === "string");
  return keys.length === 0 ? {} : { heldKeys: keys };
}

/**
 * Map an OpenAI computer action object to a provider-neutral CuaAction, or null
 * for an unknown type. Every coordinate and field is read defensively so a
 * malformed action never throws and a non-number coordinate becomes 0.
 */
export function openAiActionToCua(action: unknown): CuaAction | null {
  const record = asRecord(action);
  const type = asString(record.type);
  switch (type) {
    case "click": {
      const button = record.button;
      // The API names the middle button `wheel`. Its back and forward buttons navigate the
      // browser's history wherever the pointer is, so they run as the same keyboard shortcuts;
      // the executors have no mouse button 8 or 9.
      // Held keys join the shortcut, so a held key the shortcut repeats is refused, not dropped.
      const held = heldKeysOf(record).heldKeys ?? [];
      if (button === "back") return { kind: "keypress", keys: [...held, "ALT", "LEFT"] };
      if (button === "forward") return { kind: "keypress", keys: [...held, "ALT", "RIGHT"] };
      return {
        kind: "click",
        x: asNumber(record.x),
        y: asNumber(record.y),
        button:
          button === "right"
            ? "right"
            : button === "wheel" || button === "middle"
              ? "middle"
              : "left",
        ...heldKeysOf(record),
      };
    }
    case "double_click":
      return {
        kind: "double_click",
        x: asNumber(record.x),
        y: asNumber(record.y),
        ...heldKeysOf(record),
      };
    case "move":
      return { kind: "move", x: asNumber(record.x), y: asNumber(record.y), ...heldKeysOf(record) };
    case "scroll":
      return {
        kind: "scroll",
        x: asNumber(record.x),
        y: asNumber(record.y),
        dx: asNumber(record.scroll_x),
        dy: asNumber(record.scroll_y),
        ...heldKeysOf(record),
      };
    case "type":
      return { kind: "type", text: asString(record.text) };
    case "keypress":
      return {
        kind: "keypress",
        keys: asArray(record.keys).filter((key): key is string => typeof key === "string"),
      };
    case "drag":
      return { kind: "drag", path: asArray(record.path).map(asPoint), ...heldKeysOf(record) };
    case "wait":
      return { kind: "wait" };
    case "screenshot":
      return { kind: "screenshot" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Response parsing.
// ---------------------------------------------------------------------------

export interface ParsedOpenAiResponse {
  turn: CuaTurn;
  callIds: string[];
  outputItems: unknown[];
}

// Collect plain strings or { text } entries from a reasoning summary/content array.
function collectTextEntries(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      if (entry.length > 0) out.push(entry);
      continue;
    }
    const text = asString(asRecord(entry).text);
    if (text.length > 0) out.push(text);
  }
  return out;
}

// Collect output_text strings from a message content array.
function collectMessageText(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (asString(record.type) === "output_text") {
      const text = asString(record.text);
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

/**
 * Parse a Responses API response into a provider-neutral CuaTurn plus the
 * computer_call ids (needed to build the next turn's call outputs) and the raw
 * output items (needed for ZDR explicit-context continuation). Pure: no network,
 * no mutation of the input. Optional CuaTurn fields are only set when present so
 * the result satisfies exactOptionalPropertyTypes.
 */
export function parseOpenAiResponse(raw: unknown): ParsedOpenAiResponse {
  const root = asRecord(raw);
  const responseId = optionalString(root.id);
  const output = asArray(root.output);

  const actions: CuaAction[] = [];
  const callIds: string[] = [];
  const reasoningParts: string[] = [];
  const messageParts: string[] = [];
  const safetyChecks: CuaSafetyCheck[] = [];

  for (const rawItem of output) {
    const item = asRecord(rawItem);
    switch (asString(item.type)) {
      case "reasoning":
        reasoningParts.push(
          ...collectTextEntries(item.summary),
          ...collectTextEntries(item.content),
        );
        break;
      case "message":
        messageParts.push(...collectMessageText(item.content));
        break;
      case "output_text": {
        const text = asString(item.text);
        if (text.length > 0) messageParts.push(text);
        break;
      }
      case "computer_call": {
        const callId = optionalString(item.call_id);
        if (callId !== undefined) callIds.push(callId);
        // The live Responses API returns the actions as an array (`item.actions`); a single
        // computer_call can carry several. (An older/alt shape used a singular `item.action` —
        // supported as a fallback.) Reading only `item.action` silently dropped every action,
        // which made the loop see zero actions and stop on a false `goal_satisfied`.
        const rawActions = Array.isArray(item.actions)
          ? item.actions
          : item.action !== undefined
            ? [item.action]
            : [];
        for (const rawAction of rawActions) {
          const mapped = openAiActionToCua(rawAction);
          if (mapped !== null) actions.push(mapped);
        }
        // Preserve the wire triple verbatim: the API matches acknowledgements on
        // `id`, so collapsing to a code string (and fabricating ids on echo)
        // would silently break the proceed path.
        for (const rawCheck of asArray(item.pending_safety_checks)) {
          const check = asRecord(rawCheck);
          const id = asString(check.id);
          const code = asString(check.code);
          safetyChecks.push({
            id: id || code || "safety_check",
            code: code || id || "safety_check",
            message: asString(check.message) || code || id || "safety_check",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const topText = asString(root.output_text);
  if (topText.length > 0) messageParts.push(topText);

  const reasoning = reasoningParts.filter((part) => part.length > 0).join("\n");
  const message = messageParts.filter((part) => part.length > 0).join("\n");

  const usageRecord = asRecord(root.usage);
  const usageInput = optionalNumber(usageRecord.input_tokens);
  const usageOutput = optionalNumber(usageRecord.output_tokens);
  // Of the input tokens, how many the provider served from its prompt cache. This loop threads
  // state with previous_response_id and re-sends a growing warm prefix every turn, so most input on
  // a long session is a cache hit billed at a fraction of the full rate. Not reading it made every
  // cost line materially overstate the bill (#391).
  const usageCachedInput = optionalNumber(asRecord(usageRecord.input_tokens_details).cached_tokens);
  // GPT-5.6+ bills cache writes (1.25x input) and reports them here; older models omit the field.
  const usageCacheWriteInput = optionalNumber(
    asRecord(usageRecord.input_tokens_details).cache_write_tokens,
  );
  const usage =
    usageInput === undefined && usageOutput === undefined
      ? undefined
      : {
          ...(usageInput === undefined ? {} : { input: usageInput }),
          ...(usageOutput === undefined ? {} : { output: usageOutput }),
          ...(usageCachedInput === undefined ? {} : { cachedInput: usageCachedInput }),
          ...(usageCacheWriteInput === undefined ? {} : { cacheWriteInput: usageCacheWriteInput }),
        };

  // Responses can exhaust output/context tokens before producing any visible answer. Empty
  // actions on that wire status are an interrupted generation, never a natural endpoint.
  const interruption =
    root.status === "incomplete"
      ? asRecord(root.incomplete_details).reason === "max_output_tokens"
        ? "output_limit"
        : "incomplete"
      : root.status !== undefined && root.status !== "completed"
        ? "unexpected_status"
        : undefined;

  const turn: CuaTurn = {
    actions,
    pendingSafetyChecks: safetyChecks,
    done: interruption === undefined && actions.length === 0,
    ...(interruption === undefined ? {} : { interruption }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(message.length > 0 ? { message } : {}),
    ...(usage === undefined ? {} : { usage }),
  };

  return { turn, callIds, outputItems: output };
}

// ---------------------------------------------------------------------------
// Request builders. Each returns a plain object that is JSON-serialized as the
// POST body. They never carry the apiKey (that lives only in the header).
// ---------------------------------------------------------------------------

export type OpenAiReasoningSummary = "auto" | "concise" | "detailed";

export interface OpenAiCuContext {
  model: string;
  instructions: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  /** When set, request provider-sanctioned reasoning summaries (#427). Absent = do not ask. */
  reasoningSummary?: OpenAiReasoningSummary;
  safetyIdentifier?: string;
}

// The fields shared by the initial and continuation requests: the tool spec,
// truncation policy, reasoning effort, and (when configured) the safety id.
function sharedRequestFields(ctx: OpenAiCuContext): Record<string, unknown> {
  return {
    model: ctx.model,
    ...(ctx.maxOutputTokens === undefined ? {} : { max_output_tokens: ctx.maxOutputTokens }),
    // Keep the task/persona contract present on every turn. Some computer-use
    // continuations carry only screenshot call outputs; without repeating the
    // instructions, a provider that does not fully retain prior state can drift
    // into asking the operator what to do.
    instructions: ctx.instructions,
    // The Responses API `computer` tool takes no display/environment fields — the model infers
    // resolution from the screenshots it is sent. (Sending display_* returns a 400
    // "Unknown parameter tools[0].display_width", confirmed against the live API 2026-06.)
    tools: [{ type: "computer" }],
    truncation: "auto",
    // `summary` asks for the provider-SANCTIONED reasoning summary items (#427) — the
    // capture side never scrapes or reconstructs raw chain-of-thought. Parsed by
    // parseOpenAiResponse into turn.reasoning; the loop records them as redacted
    // `kind: "reasoning"` trace items.
    reasoning: {
      effort: ctx.reasoningEffort,
      ...(ctx.reasoningSummary === undefined ? {} : { summary: ctx.reasoningSummary }),
    },
    ...(ctx.safetyIdentifier === undefined ? {} : { safety_identifier: ctx.safetyIdentifier }),
  };
}

/**
 * The first request's output limit. A first request can spend its whole allowance inside an
 * unfinished computer_call; this bound ends that within seconds while leaving several times the
 * room a completed first turn uses (a screenshot request of a few dozen tokens).
 */
const FIRST_TURN_OUTPUT_LIMIT = 1024;

/**
 * Build the first-turn request body: the instructions and the first screen, so the first decision
 * is made with the page in view. Its output limit is FIRST_TURN_OUTPUT_LIMIT, or the declared
 * limit when that is lower.
 */
export function buildInitialRequest(
  ctx: OpenAiCuContext,
  screenshot?: Buffer,
): Record<string, unknown> {
  const maxOutputTokens = Math.min(
    ctx.maxOutputTokens ?? FIRST_TURN_OUTPUT_LIMIT,
    FIRST_TURN_OUTPUT_LIMIT,
  );
  return {
    ...sharedRequestFields({ ...ctx, maxOutputTokens }),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: ctx.instructions },
          ...(screenshot === undefined
            ? []
            : [
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${screenshot.toString("base64")}`,
                },
              ]),
        ],
      },
    ],
  };
}

/**
 * Build one computer_call_output for a pending call id, carrying the latest
 * screenshot as an inline data URL. Acknowledged safety checks (if any) are
 * echoed back so the model can proceed past a check the harness approved.
 *
 * The screenshot param is `Buffer | undefined` because CuaObservation.screenshot is now
 * optional (a non-vision executor omits it). This provider is a vision model (it sets
 * requiresFrame), so a missing frame is a hard error here — defense-in-depth: the loop's
 * per-turn requiresFrame guard already fails closed before this is reached, but throwing keeps
 * the mapper self-validating and isolable.
 */
export function buildCallOutput(
  callId: string,
  screenshot: Buffer | undefined,
  acknowledged?: CuaSafetyCheck[],
): Record<string, unknown> {
  if (screenshot === undefined) {
    throw new Error(
      "openai-responses-cu requires observation.screenshot (it is a vision provider; pair a state-only executor with a non-vision provider)",
    );
  }
  return {
    type: "computer_call_output",
    call_id: callId,
    output: {
      type: "computer_screenshot",
      image_url: `data:image/png;base64,${screenshot.toString("base64")}`,
    },
    ...(acknowledged && acknowledged.length > 0
      ? {
          acknowledged_safety_checks: acknowledged.map(({ id, code, message }) => ({
            id,
            code,
            message,
          })),
        }
      : {}),
  };
}

export interface ContinuationRequestArgs {
  ctx: OpenAiCuContext;
  previousResponseId: string | undefined;
  callOutputs: object[];
  contextHint?: string;
  explicitContextItems?: unknown[];
}

// Turn an optional context-hint string into an input item array (or empty).
function hintItems(contextHint: string | undefined): unknown[] {
  return contextHint
    ? [{ role: "user", content: [{ type: "input_text", text: contextHint }] }]
    : [];
}

/**
 * Build a continuation request body. Two modes:
 *  - default: thread server-side state via previous_response_id and send only the
 *    new call outputs (plus an optional hint).
 *  - explicit-context (ZDR): no previous_response_id; the prior output items are
 *    re-sent inline ahead of the new call outputs so the model has full context
 *    without the server retaining any.
 */
export function buildContinuationRequest(args: ContinuationRequestArgs): Record<string, unknown> {
  const { ctx, previousResponseId, callOutputs, contextHint, explicitContextItems } = args;
  if (explicitContextItems === undefined) {
    return {
      ...sharedRequestFields(ctx),
      previous_response_id: previousResponseId,
      input: [...callOutputs, ...hintItems(contextHint)],
    };
  }
  return {
    ...sharedRequestFields(ctx),
    input: [...explicitContextItems, ...callOutputs, ...hintItems(contextHint)],
  };
}
