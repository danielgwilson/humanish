import type { CuaAction, CuaTurn } from "./loop.js";
import { CUA_WAIT_LIMITS } from "./wait.js";
import {
  isFiniteNumber,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
} from "../../run/type-guards.js";

// The Anthropic Messages computer-use wire, mapped to and from the provider-neutral CuaAction and
// CuaTurn. Everything here is pure: the member table, the reply parser, the usage mapping and the
// request-body builders touch no network and no key. What each request carries is
// anthropic-conversation.ts; the client that posts it is anthropic-provider.ts. The fixtures for
// this module come from captured responses (tests/fixtures/anthropic-messages/).

/** The toolset every request declares, with all of its members on. */
const COMPUTER_TOOLSET = { type: "computer_toolset_20260801" } as const;

/** The `toolset_name` of a member call, which each of its results echoes. */
const COMPUTER = "computer";

/**
 * The documented answer to every action of a batch after the one that failed. The model reads
 * this exact text as "this action never ran" and plans again from there.
 */
export const HALT_TEXT = "Not executed: an earlier computer action in this turn failed.";

/** A position on the screen, in the pixels of the screenshots the model is sent. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// Members: what each computer_toolset_20260801 call runs on the desktop.
// ---------------------------------------------------------------------------

/** What one member call becomes: the desktop actions it runs, in order, or why it cannot run. */
type MemberMapping = { readonly actions: readonly CuaAction[] } | { readonly rejected: string };

type MemberMapper = (
  name: string,
  input: Record<string, unknown>,
  pointer: Point | undefined,
) => MemberMapping;

// The hosted desktops scroll 100 px per wheel click (HOSTED_X11_DIALECT in
// src/substrates/x11/translator.ts), so a scroll of n clicks reaches them as n clicks.
const SCROLL_PX_PER_CLICK = 100;
const MAX_KEY_REPEAT = 100;

const ran = (...actions: CuaAction[]): MemberMapping => ({ actions });
const rejected = (reason: string): MemberMapping => ({ rejected: reason });

/** `[x, y]` in screenshot pixels, or undefined. */
function pointOf(value: unknown): Point | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value as unknown[];
  return isFiniteNumber(x) && isFiniteNumber(y) && x >= 0 && y >= 0 ? { x, y } : undefined;
}

/** The modifiers a pointer member holds (`text`: `shift`, `ctrl+shift`), as held keys. */
function heldKeysOf(input: Record<string, unknown>): { heldKeys?: string[] } {
  if (typeof input.text !== "string") return {};
  const keys = input.text.split("+").filter((key) => key !== "");
  return keys.length === 0 ? {} : { heldKeys: keys };
}

/**
 * Where a pointer member acts: its `coordinate`, or the pointer's position when it names none,
 * which the documentation allows for clicks and scrolls.
 */
function targetOf(
  name: string,
  input: Record<string, unknown>,
  pointer: Point | undefined,
): Point | string {
  if (input.coordinate === undefined) {
    return (
      pointer ??
      `${name} named no coordinate, and the pointer position is not known. Name a coordinate.`
    );
  }
  return pointOf(input.coordinate) ?? `${name} needs coordinate as [x, y] in screenshot pixels.`;
}

function click(button: "left" | "right" | "middle"): MemberMapper {
  return (name, input, pointer) => {
    const at = targetOf(name, input, pointer);
    return typeof at === "string"
      ? rejected(at)
      : ran({ kind: "click", ...at, button, ...heldKeysOf(input) });
  };
}

const doubleClick: MemberMapper = (name, input, pointer) => {
  const at = targetOf(name, input, pointer);
  return typeof at === "string"
    ? rejected(at)
    : ran({ kind: "double_click", ...at, ...heldKeysOf(input) });
};

const drag: MemberMapper = (name, input) => {
  const from = pointOf(input.start_coordinate);
  const to = pointOf(input.coordinate);
  return from === undefined || to === undefined
    ? rejected(`${name} needs start_coordinate and coordinate as [x, y] in screenshot pixels.`)
    : ran({ kind: "drag", path: [from, to], ...heldKeysOf(input) });
};

const move: MemberMapper = (name, input) => {
  const to = pointOf(input.coordinate);
  return to === undefined
    ? rejected(`${name} needs coordinate as [x, y] in screenshot pixels.`)
    : ran({ kind: "move", ...to });
};

const SCROLL_DIRECTIONS: Readonly<Record<string, { dx: number; dy: number }>> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

const scroll: MemberMapper = (name, input, pointer) => {
  const direction =
    typeof input.scroll_direction === "string"
      ? SCROLL_DIRECTIONS[input.scroll_direction]
      : undefined;
  if (direction === undefined)
    return rejected(`${name} needs scroll_direction: up, down, left or right.`);
  if (!isPositiveSafeInteger(input.scroll_amount))
    return rejected(`${name} needs scroll_amount, a whole number of wheel clicks.`);
  const at = targetOf(name, input, pointer);
  if (typeof at === "string") return rejected(at);
  const px = input.scroll_amount * SCROLL_PX_PER_CLICK;
  return ran({
    kind: "scroll",
    ...at,
    dx: direction.dx * px,
    dy: direction.dy * px,
    ...heldKeysOf(input),
  });
};

const typeText: MemberMapper = (name, input) =>
  typeof input.text === "string" && input.text !== ""
    ? ran({ kind: "type", text: input.text })
    : rejected(`${name} needs text to type.`);

/** The keys a `key` or `hold_key` call names in `text`, or undefined when it names none. */
function keysOf(text: unknown): string[] | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  // A plus sign joins two key names; a lone or trailing one is the plus key itself.
  return text.length > 1 ? text.split(/\+(?!$)/) : [text];
}

const pressKey: MemberMapper = (name, input) => {
  const keys = keysOf(input.text);
  if (keys === undefined)
    return rejected(`${name} needs text naming a key or a combination such as ctrl+s.`);
  const repeat = input.repeat ?? 1;
  if (!isPositiveSafeInteger(repeat) || repeat > MAX_KEY_REPEAT)
    return rejected(`${name} repeat must be a whole number from 1 to ${MAX_KEY_REPEAT}.`);
  return ran(...Array.from({ length: repeat }, (): CuaAction => ({ kind: "keypress", keys })));
};

const tripleClick: MemberMapper = (name, input, pointer) => {
  const at = targetOf(name, input, pointer);
  return typeof at === "string"
    ? rejected(at)
    : ran({ kind: "triple_click", ...at, ...heldKeysOf(input) });
};

/** A left-button press or release, where the pointer is or at a named coordinate. */
function leftButton(kind: "mouse_down" | "mouse_up"): MemberMapper {
  return (name, input) => {
    if (input.coordinate === undefined) return ran({ kind, button: "left" });
    const at = pointOf(input.coordinate);
    return at === undefined
      ? rejected(`${name} needs coordinate as [x, y] in screenshot pixels, or none.`)
      : ran({ kind, button: "left", ...at });
  };
}

// The desktop holds keys for at most one desktop call; the toolset allows up to 300 seconds.
const MAX_HOLD_MS = CUA_WAIT_LIMITS.stepMs;

const holdKey: MemberMapper = (name, input) => {
  const keys = keysOf(input.text);
  if (keys === undefined)
    return rejected(`${name} needs text naming a key or a combination such as shift.`);
  if (!isFiniteNumber(input.duration) || input.duration <= 0)
    return rejected(`${name} needs duration, the seconds to hold the keys.`);
  const ms = Math.max(1, Math.round(input.duration * 1000));
  return ms > MAX_HOLD_MS
    ? rejected(`${name} holds keys for at most ${MAX_HOLD_MS / 1000} seconds on this desktop.`)
    : ran({ kind: "hold_keys", keys, ms });
};

type Region = Extract<CuaAction, { kind: "zoom" }>["region"];

/** `[x0, y0, x1, y1]` in screenshot pixels as a region of whole pixels, or undefined. */
function regionOf(value: unknown): Region | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((corner) => isFiniteNumber(corner) && corner >= 0)) return undefined;
  const [x0, y0, x1, y1] = (value as number[]).map(Math.round) as [number, number, number, number];
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

const zoom: MemberMapper = (name, input) => {
  const region = regionOf(input.region);
  return region === undefined
    ? rejected(
        `${name} needs region as [x0, y0, x1, y1], the top-left and bottom-right corners in screenshot pixels.`,
      )
    : ran({ kind: "zoom", region });
};

const wait: MemberMapper = (_name, input) =>
  isFiniteNumber(input.duration) && input.duration > 0
    ? ran({ kind: "wait", ms: Math.max(1, Math.round(input.duration * 1000)) })
    : ran({ kind: "wait" });

/**
 * Every member of computer_toolset_20260801 and the desktop actions it runs. The request offers
 * all of them, so the participant works with Claude's own action set. `cursor_position` and
 * `zoom` read the desktop; the conversation answers them from what their acknowledgement read.
 */
const COMPUTER_MEMBERS: Readonly<Record<string, MemberMapper>> = {
  screenshot: () => ran({ kind: "screenshot" }),
  left_click: click("left"),
  right_click: click("right"),
  middle_click: click("middle"),
  double_click: doubleClick,
  left_click_drag: drag,
  mouse_move: move,
  scroll,
  type: typeText,
  key: pressKey,
  wait,
  triple_click: tripleClick,
  left_mouse_down: leftButton("mouse_down"),
  left_mouse_up: leftButton("mouse_up"),
  hold_key: holdKey,
  cursor_position: () => ran({ kind: "read_pointer" }),
  zoom,
};

/** Where the pointer is after `action` completes, or undefined when the action does not move it. */
export function pointerAfter(action: CuaAction): Point | undefined {
  switch (action.kind) {
    case "click":
    case "double_click":
    case "triple_click":
    case "move":
    case "scroll":
      return { x: action.x, y: action.y };
    case "mouse_down":
    case "mouse_up":
      return action.x === undefined || action.y === undefined
        ? undefined
        : { x: action.x, y: action.y };
    case "drag":
      return action.path.at(-1);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Replies.
// ---------------------------------------------------------------------------

/** One tool_use block of a reply, which the next request answers with one tool_result. */
export interface MemberCall {
  readonly id: string;
  /** The block's `toolset_name`, echoed on its result; `computer` for every member call. */
  readonly toolsetName: string | undefined;
  readonly name: string;
  /**
   * The batch positions of the actions this call runs, in order. Empty for a call after the
   * reply's rejected proposal, which never runs.
   */
  readonly positions: readonly number[];
  /** Why this call could not run; it holds the turn's rejected-proposal position. */
  readonly rejected?: string;
}

export interface ParsedMessage {
  readonly turn: CuaTurn;
  /** The reply's content blocks verbatim, thinking signatures included, for the next request. */
  readonly content: readonly unknown[];
  readonly calls: readonly MemberCall[];
  readonly stopReason: string | undefined;
  /** Why the reply's usage cannot be priced from the rate table, when it cannot. */
  readonly unpricedUsage?: string;
  /** Input tokens the server's tool-result clearing removed before the model read the request. */
  readonly clearedInputTokens?: number;
}

const INTERRUPTIONS: Readonly<Record<string, CuaTurn["interruption"]>> = {
  max_tokens: "output_limit",
  model_context_window_exceeded: "token_limit",
  refusal: "refused",
};

/**
 * Parse a Messages reply into a CuaTurn and the member calls the next request answers. Calls map
 * in order from the pointer position `pointer`; the first that cannot map becomes the turn's
 * rejected proposal, and every later call runs nothing. Pure.
 */
export function parseMessage(raw: unknown, pointer: Point | undefined): ParsedMessage {
  const root = isRecord(raw) ? raw : {};
  const content = Array.isArray(root.content) ? (root.content as unknown[]) : [];
  const reasoning: string[] = [];
  const message: string[] = [];
  const actions: CuaAction[] = [];
  const calls: MemberCall[] = [];
  let rejectedProposal: CuaTurn["rejectedProposal"];
  let at = pointer;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
      reasoning.push(block.thinking.trim());
    if (block.type === "text" && typeof block.text === "string" && block.text.trim())
      message.push(block.text.trim());
    if (block.type !== "tool_use" || typeof block.id !== "string") continue;
    const name = typeof block.name === "string" ? block.name : "";
    const toolsetName = typeof block.toolset_name === "string" ? block.toolset_name : undefined;
    const call = { id: block.id, toolsetName, name };
    if (rejectedProposal !== undefined) {
      calls.push({ ...call, positions: [] });
      continue;
    }
    const mapping = mapMember(call, isRecord(block.input) ? block.input : {}, at);
    if ("rejected" in mapping) {
      rejectedProposal = { reason: mapping.rejected };
      calls.push({ ...call, positions: [actions.length], rejected: mapping.rejected });
      continue;
    }
    const start = actions.length;
    actions.push(...mapping.actions);
    for (const action of mapping.actions) at = pointerAfter(action) ?? at;
    calls.push({ ...call, positions: mapping.actions.map((_, offset) => start + offset) });
  }
  const stopReason = typeof root.stop_reason === "string" ? root.stop_reason : undefined;
  const interruption =
    stopReason === undefined || stopReason === "end_turn" || stopReason === "tool_use"
      ? undefined
      : (INTERRUPTIONS[stopReason] ?? "unexpected_status");
  const stopDetails = isRecord(root.stop_details) ? root.stop_details : {};
  const usage = isRecord(root.usage) ? root.usage : undefined;
  const turnUsage = usage === undefined ? undefined : usageOf(usage);
  const unpriced = usage === undefined ? undefined : unpricedUsage(usage);
  const cleared = clearedInputTokens(root.context_management);
  const turn: CuaTurn = {
    actions,
    pendingSafetyChecks: [],
    done: interruption === undefined && calls.length === 0,
    ...(rejectedProposal === undefined ? {} : { rejectedProposal }),
    ...(interruption === undefined ? {} : { interruption }),
    ...(interruption === "refused" && typeof stopDetails.category === "string"
      ? { refusalCategory: stopDetails.category }
      : {}),
    ...(typeof root.id === "string" ? { responseId: root.id } : {}),
    ...(reasoning.length > 0 ? { reasoning: reasoning.join("\n") } : {}),
    ...(message.length > 0 ? { message: message.join("\n") } : {}),
    ...(turnUsage === undefined ? {} : { usage: turnUsage }),
  };
  return {
    turn,
    content,
    calls,
    stopReason,
    ...(unpriced === undefined ? {} : { unpricedUsage: unpriced }),
    ...(cleared === undefined ? {} : { clearedInputTokens: cleared }),
  };
}

function mapMember(
  call: Pick<MemberCall, "name" | "toolsetName">,
  input: Record<string, unknown>,
  pointer: Point | undefined,
): MemberMapping {
  const mapper = Object.hasOwn(COMPUTER_MEMBERS, call.name)
    ? COMPUTER_MEMBERS[call.name]
    : undefined;
  if (call.toolsetName !== COMPUTER || mapper === undefined)
    return rejected(`There is no computer action named ${JSON.stringify(call.name)}.`);
  return mapper(call.name, input, pointer);
}

function clearedInputTokens(value: unknown): number | undefined {
  if (!isRecord(value) || !Array.isArray(value.applied_edits)) return undefined;
  let cleared = 0;
  for (const edit of value.applied_edits as unknown[]) {
    if (isRecord(edit) && isNonNegativeSafeInteger(edit.cleared_input_tokens))
      cleared += edit.cleared_input_tokens;
  }
  return cleared > 0 ? cleared : undefined;
}

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

type TurnUsage = NonNullable<CuaTurn["usage"]>;
type InferenceUsage = NonNullable<TurnUsage["turns"]>[number] & {
  input: number;
  output: number;
};

/**
 * One inference's counts in humanish's shape. Anthropic's `input_tokens` counts only the uncached
 * input, where humanish's `input` holds every input token with the cache reads and writes as parts
 * of it, so the three add up. Thinking tokens are part of `output_tokens`.
 */
function inferenceUsage(record: Record<string, unknown>): InferenceUsage | undefined {
  const {
    input_tokens: uncached,
    output_tokens: output,
    cache_read_input_tokens: read = 0,
    cache_creation_input_tokens: write = 0,
  } = record;
  if (
    !isNonNegativeSafeInteger(uncached) ||
    !isNonNegativeSafeInteger(output) ||
    !isNonNegativeSafeInteger(read) ||
    !isNonNegativeSafeInteger(write)
  )
    return undefined;
  return { input: uncached + read + write, output, cachedInput: read, cacheWriteInput: write };
}

/**
 * A reply's usage with one `turns` entry per inference the request billed: each entry of
 * `usage.iterations` (a compaction runs as an inference of its own, which the top-level counts
 * leave out), or the top-level counts when there are no iterations. The totals are the sums of
 * the entries. Undefined when any entry lacks a count.
 */
function usageOf(usage: Record<string, unknown>): TurnUsage | undefined {
  const records =
    Array.isArray(usage.iterations) && usage.iterations.length > 0
      ? (usage.iterations as unknown[])
      : [usage];
  const turns: InferenceUsage[] = [];
  for (const record of records) {
    const counts = isRecord(record) ? inferenceUsage(record) : undefined;
    if (counts === undefined) return undefined;
    turns.push(counts);
  }
  const sum = (field: "input" | "output" | "cachedInput" | "cacheWriteInput"): number =>
    turns.reduce((total, turn) => total + (turn[field] ?? 0), 0);
  return {
    input: sum("input"),
    output: sum("output"),
    cachedInput: sum("cachedInput"),
    cacheWriteInput: sum("cacheWriteInput"),
    turns,
  };
}

/**
 * Why a reply's usage cannot be priced from the rate table, which holds the standard tier's
 * global-inference rates with 5-minute cache writes: a reply served in another inference region
 * (a workspace setting; `us` bills 1.1x), on another service tier, or with 1-hour cache writes
 * (2x the input rate). Undefined when the rate table prices it.
 */
function unpricedUsage(usage: Record<string, unknown>): string | undefined {
  const geo = usage.inference_geo;
  if (typeof geo === "string" && geo !== "global")
    return `The reply was served in inference region "${geo}", which the workspace's inference geography setting chose and which bills above the global rates the estimate uses.`;
  const tier = usage.service_tier;
  if (typeof tier === "string" && tier !== "standard")
    return `The reply was served on service tier "${tier}", which has no rate in humanish's table.`;
  const records = [usage, ...(Array.isArray(usage.iterations) ? usage.iterations : [])];
  const hourWrites = records.reduce<number>((total, record) => {
    const cache = isRecord(record) && isRecord(record.cache_creation) ? record.cache_creation : {};
    return (
      total +
      (isNonNegativeSafeInteger(cache.ephemeral_1h_input_tokens)
        ? cache.ephemeral_1h_input_tokens
        : 0)
    );
  }, 0);
  if (hourWrites > 0)
    return `The reply wrote ${hourWrites} tokens to the 1-hour prompt cache, which bills 2x the input rate; the estimate prices 5-minute cache writes only.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Requests. Each builder returns a plain object that is JSON-serialized as the POST body; none
// carries the key, which lives only in a header.
// ---------------------------------------------------------------------------

/** The effort levels the Messages API accepts. */
export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

/** How every request of a session asks the model to run. */
export interface MessagesSettings {
  readonly model: string;
  readonly effort: AnthropicEffort;
  readonly maxOutputTokens: number;
}

/** A closing request's output limit: its own cap, or the session's limit when that is lower. */
const CLOSING_OUTPUT_LIMIT = 4096;

/**
 * Server-side tool-result clearing: past 60,000 input tokens, the oldest screenshots' results are
 * cleared before the model reads the request, keeping the newest 8 tool uses, and only when the
 * clearing frees 20,000 tokens or more, since each clearing rewrites the cached prefix. The
 * trigger matches the OpenAI provider's 64,000-token conversation budget and keeps requests
 * under the 100,000-token prompt above which Claude Haiku 5.5 bills 5x. Clearing on the server
 * keeps the client's history append-only, which the thinking blocks in it require.
 */
const CONTEXT_MANAGEMENT = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 60_000 },
      keep: { type: "tool_uses", value: 8 },
      clear_at_least: { type: "input_tokens", value: 20_000 },
    },
  ],
} as const;

/**
 * A request body. Every request carries the same system prompt, toolset, thinking, effort, cache
 * and clearing settings, so each one's prefix is the one before it. Thinking is adaptive with
 * readable summaries, and `prefix_mismatch_behavior: "error"` makes any edit of earlier history
 * a 400 in place of reasoning silently dropped. A closing request sends no tool choice, its own
 * output limit and, on its strict retry, the reply's JSON Schema.
 */
export function requestBody(
  settings: MessagesSettings,
  instructions: string,
  messages: readonly unknown[],
  closing?: { readonly schema?: Record<string, unknown> },
): Record<string, unknown> {
  const format =
    closing?.schema === undefined
      ? {}
      : { format: { type: "json_schema", schema: closing.schema } };
  return {
    model: settings.model,
    max_tokens:
      closing === undefined
        ? settings.maxOutputTokens
        : Math.min(settings.maxOutputTokens, CLOSING_OUTPUT_LIMIT),
    system: [{ type: "text", text: instructions }],
    tools: [COMPUTER_TOOLSET],
    ...(closing === undefined ? {} : { tool_choice: { type: "none" } }),
    thinking: {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "error" },
    },
    output_config: { effort: settings.effort, ...format },
    cache_control: { type: "ephemeral" },
    context_management: CONTEXT_MANAGEMENT,
    messages: [...messages],
  };
}

/**
 * One message, read as the words of `sender`: the user, the model, or the operator (a system
 * message in the conversation, which carries harness guidance without changing earlier turns).
 */
export function message(
  sender: "user" | "assistant" | "system",
  content: string | readonly unknown[],
): Record<string, unknown> {
  return { role: sender, content: typeof content === "string" ? content : [...content] };
}

/** A tool_result answering `call`: text, then optionally the screen. */
export function toolResult(
  call: Pick<MemberCall, "id" | "toolsetName">,
  text: string,
  options: { readonly isError?: boolean; readonly screen?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    ...(call.toolsetName === undefined ? {} : { toolset_name: call.toolsetName }),
    ...(options.isError === true ? { is_error: true } : {}),
    content: [{ type: "text", text }, ...(options.screen === undefined ? [] : [options.screen])],
  };
}

// Claude reads at most 2,576 px on the long edge and 4,784 visual tokens (one per 28x28 tile), and
// at most 2,000 px a side once a request carries more than 20 images, which a session's history
// soon does. The API does not downscale, so a larger frame is a 400 after the desktop is up.
const MAX_SIDE_PX = 2000;
const MAX_VISUAL_TOKENS = 4784;

/** A frame's width and height in pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A PNG's width and height from its IHDR chunk, or undefined for anything else. */
export function pngSize(bytes: Buffer): Size | undefined {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) return undefined;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The image block for one desktop frame, after checking it fits what Claude reads. Throws before
 * any request when it does not, or when there is no frame: this is a vision provider
 * (requiresFrame), so the loop's own guard normally refuses a frameless executor first.
 */
export function screenImage(screenshot: Buffer | undefined): Record<string, unknown> {
  if (screenshot === undefined) {
    throw new Error(
      "anthropic-messages-cu requires observation.screenshot (it is a vision provider; pair a state-only executor with a non-vision provider)",
    );
  }
  const size = pngSize(screenshot);
  if (size === undefined)
    throw new Error("The desktop's screenshot is not a PNG image, the only frame format sent.");
  const tokens = Math.ceil(size.width / 28) * Math.ceil(size.height / 28);
  if (size.width > MAX_SIDE_PX || size.height > MAX_SIDE_PX || tokens > MAX_VISUAL_TOKENS) {
    throw new Error(
      `Claude reads screenshots up to ${MAX_SIDE_PX} px a side and ${MAX_VISUAL_TOKENS} visual tokens, and this desktop's screenshot is ${size.width}x${size.height} (${tokens} visual tokens). Use a smaller execution.desktop.resolution, such as 1440x950.`,
    );
  }
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") },
  };
}

/** The reply as wire capture writes it: thinking signatures are opaque and never written. */
export function forCapture(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(forCapture);
  if (!isRecord(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      key === "signature" && typeof value === "string" ? "<signature removed>" : forCapture(value),
    ]),
  );
}
