import { asArray, asRecord, inputMessage, openAiActionToCua } from "./openai-wire.js";
import type { CuaAction } from "./loop.js";

// The conversation an explicit-context request carries, kept on the client because the server
// keeps none (a zero-data-retention org, or zeroDataRetention set). Requests made while the
// provider still threads on previous_response_id feed it too, so a switch partway through a
// session keeps everything before the switch.
//
// The Responses API pairs items: every computer_call needs its computer_call_output, and a
// reasoning item travels with the item it preceded. The conversation is therefore cut only at
// exchange boundaries: one reply's output items together with the items that answered them.
// When the estimate passes the budget, the conversation is cut down to half the budget in one
// step: the opening screenshot goes first, then the oldest exchanges become lines of a progress
// note that keeps their reasoning summaries, messages and actions, and the text that answered
// them, such as a note that an action was not run. The note is an
// assistant message, so text the model wrote (which can quote a web page) keeps the trust it had
// when the model wrote it. The newest MIN_KEPT_EXCHANGES exchanges are never collapsed, so a
// request passes the budget when they alone exceed it; the trace's per-request estimate shows when
// that happens.
//
// A cut rewrites the start of the prompt, so the provider's prompt cache misses on the request
// after it. Between cuts nothing already sent changes: each request starts with the whole of the
// previous request, and the cache serves all of it. A cut of one exchange per turn would rewrite
// the note on every request past the budget, and each of those requests would be billed in full.

/** The estimated input a carried conversation may reach before it is cut. */
export const CONTEXT_TOKEN_BUDGET = 64_000;
/**
 * The share of the budget a cut brings the carried conversation down to. The rest is the growth
 * the cache serves until the next cut: about 19 turns of 1280x800 screenshots, or 12 at
 * 1920x1080.
 */
const CUT_TARGET_SHARE = 0.5;
/** Exchanges always carried whole, so the model sees its latest actions with their screens. */
const MIN_KEPT_EXCHANGES = 2;
/**
 * The progress note's length cap, about 8,000 tokens. Past it, the oldest lines after the first
 * NOTE_HEAD_LINES are counted instead of shown. The note sits in the cached prefix between cuts,
 * so its size costs little after the request that writes it.
 */
const NOTE_CHAR_LIMIT = 32_000;
/**
 * Note lines kept whatever the note's length. A session's first turns are where it usually learns
 * what it must carry to the end, such as an account, an address or a code, and the newest lines
 * hold its latest progress, so the note gives up the turns between them.
 */
const NOTE_HEAD_LINES = 4;
/** One note line's cap, so a reply with many actions cannot push the note past its own cap. */
const LINE_CHAR_LIMIT = 1_500;
/**
 * Image input tokens per 32-pixel patch. The gpt-5.x and gpt-6 models bill 1.2 per patch, and at
 * the default (auto) detail gpt-5.6 and gpt-6 keep the screenshot's own size. Models that resize
 * to a lower patch budget bill less, so the estimate errs high for them.
 */
const TOKENS_PER_PATCH = 1.2;
/** A screenshot whose size cannot be read is estimated as a 2,500-patch image. */
const UNKNOWN_IMAGE_TOKENS = 3_000;

interface NoteLine {
  readonly turn: number;
  readonly text: string;
}

interface CarriedExchange {
  /** The accepted reply's number, from 1; a reply set aside at its output limit is not counted. */
  readonly turn: number;
  readonly output: readonly unknown[];
  readonly answers: readonly unknown[];
}

/** What the next request would carry, for the trace. */
export interface CarriedContextSize {
  readonly exchanges: number;
  readonly screenshots: number;
  readonly notedTurns: number;
  readonly estimatedTokens: number;
}

export class CarriedConversation {
  private opening: Record<string, unknown> | undefined;
  private readonly exchanges: CarriedExchange[] = [];
  /** The latest accepted reply's output items, which the next request answers. */
  private pending: { turn: number; output: readonly unknown[] } | undefined;
  private readonly notes: NoteLine[] = [];
  /**
   * The turns whose note lines were dropped to keep the note under its cap. Lines are dropped in
   * turn order from just after the head, so they are one run of consecutive turns.
   */
  private elided: { first: number; last: number } | undefined;
  private collapsedTurns = 0;

  constructor(private readonly budget = CONTEXT_TOKEN_BUDGET) {}

  /**
   * Record an accepted reply. `sent` is what that request added after the carried items: the
   * opening message on the first request, then the call outputs and any hint.
   */
  accept(turn: number, sent: readonly unknown[], output: readonly unknown[]): void {
    if (this.pending === undefined) {
      this.opening = asRecord(sent[0]);
    } else {
      this.exchanges.push({ turn: this.pending.turn, output: this.pending.output, answers: sent });
    }
    this.pending = { turn, output };
    this.trim();
  }

  /** The items to send ahead of a request's own new items. */
  carried(): unknown[] {
    const note = this.noteItem();
    return [
      ...(this.opening === undefined ? [] : [this.opening]),
      ...(note === undefined ? [] : [note]),
      ...this.exchanges.flatMap((exchange) => [...exchange.output, ...exchange.answers]),
      ...(this.pending?.output ?? []),
    ];
  }

  /** The carried context's size, for the trace. */
  size(): CarriedContextSize {
    const items = this.carried();
    return {
      exchanges: this.exchanges.length + (this.pending === undefined ? 0 : 1),
      screenshots: items.reduce<number>((count, item) => count + imagesOf(item).length, 0),
      notedTurns: this.collapsedTurns,
      estimatedTokens: estimateTokens(items),
    };
  }

  private trim(): void {
    if (estimateTokens(this.carried()) <= this.budget) return;
    const target = Math.floor(this.budget * CUT_TARGET_SHARE);
    while (estimateTokens(this.carried()) > target) {
      if (this.opening !== undefined && imagesOf(this.opening).length > 0) {
        this.opening = withoutImages(this.opening);
        continue;
      }
      if (this.exchanges.length <= MIN_KEPT_EXCHANGES) return;
      const oldest = this.exchanges.shift()!;
      this.notes.push({ turn: oldest.turn, text: describeExchange(oldest) });
      this.collapsedTurns += 1;
      this.capNote();
    }
  }

  private capNote(): void {
    while (this.noteText().length > NOTE_CHAR_LIMIT && this.notes.length > NOTE_HEAD_LINES + 1) {
      const [dropped] = this.notes.splice(NOTE_HEAD_LINES, 1);
      this.elided = { first: this.elided?.first ?? dropped!.turn, last: dropped!.turn };
    }
  }

  private noteText(): string {
    const lines = this.notes.map((line) => line.text);
    if (this.elided !== undefined) {
      const { first, last } = this.elided;
      const which = first === last ? `Turn ${first} is` : `Turns ${first} to ${last} are`;
      lines.splice(NOTE_HEAD_LINES, 0, `(${which} not listed.)`);
    }
    return lines.join("\n");
  }

  private noteItem(): Record<string, unknown> | undefined {
    if (this.notes.length === 0) return undefined;
    const lead =
      `My notes on my earlier turns in this session, oldest first. Their screenshots are no ` +
      `longer shown; this is what I thought, said and did, and what I was told after.`;
    return inputMessage("assistant", [
      { type: "output_text", text: `${lead}\n${this.noteText()}` },
    ]);
  }
}

/**
 * One exchange as a progress-note line: its reasoning summary, message and actions, and the text
 * that came back with their screenshot, such as a note that an action was not run.
 */
function describeExchange(exchange: CarriedExchange): string {
  const thought: string[] = [];
  const said: string[] = [];
  const did: string[] = [];
  const told: string[] = [];
  for (const raw of exchange.answers) {
    const item = asRecord(raw);
    if (item.role !== "user") continue;
    for (const entry of asArray(item.content)) {
      const text = asRecord(entry).text;
      if (typeof text === "string" && text.length > 0) told.push(text);
    }
  }
  for (const raw of exchange.output) {
    const item = asRecord(raw);
    if (item.type === "reasoning")
      for (const entry of asArray(item.summary)) {
        const text = asRecord(entry).text;
        if (typeof text === "string" && text.length > 0) thought.push(text);
      }
    if (item.type === "message")
      for (const entry of asArray(item.content)) {
        const text = asRecord(entry).text;
        if (typeof text === "string" && text.length > 0) said.push(text);
      }
    if (item.type === "computer_call") {
      const actions = Array.isArray(item.actions) ? item.actions : [item.action];
      for (const action of actions) {
        const mapped = openAiActionToCua(action);
        if (mapped !== null) did.push(describeAction(mapped));
      }
    }
  }
  const parts = [
    thought.length > 0 ? `thought: ${clip(thought.join(" "), 400)}` : undefined,
    said.length > 0 ? `said: ${clip(said.join(" "), 300)}` : undefined,
    did.length > 0 ? `did: ${clip(did.join(", "), 400)}` : undefined,
    told.length > 0 ? `was told: ${clip(told.join(" "), 300)}` : undefined,
  ].filter((part) => part !== undefined);
  const line = `Turn ${exchange.turn}: ${parts.length > 0 ? parts.join("; ") : "no recorded output"}`;
  return `${clip(line, LINE_CHAR_LIMIT - 1)}.`;
}

function describeAction(action: CuaAction): string {
  switch (action.kind) {
    case "click":
    case "double_click":
    case "move":
      return `${action.kind} (${action.x}, ${action.y})`;
    case "scroll":
      return `scroll at (${action.x}, ${action.y}) by (${action.dx}, ${action.dy})`;
    case "type":
      return `type ${JSON.stringify(clip(action.text, 120))}`;
    case "keypress":
      return `keypress ${action.keys.join("+")}`;
    default:
      return action.kind;
  }
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
}

/** The data URLs of the images an input item carries. */
function imagesOf(item: unknown): string[] {
  const record = asRecord(item);
  const output = asRecord(record.output);
  const urls: string[] = [];
  if (typeof output.image_url === "string") urls.push(output.image_url);
  for (const part of asArray(record.content)) {
    const url = asRecord(part).image_url;
    if (typeof url === "string") urls.push(url);
  }
  return urls;
}

function withoutImages(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    content: asArray(item.content).filter((part) => asRecord(part).type !== "input_image"),
  };
}

/**
 * A rough input-token estimate: images by their size in 32-pixel patches, everything else at four
 * characters a token. It decides when to trim, not what is billed; the trace records the billed
 * input per request beside it.
 */
export function estimateTokens(items: readonly unknown[]): number {
  let tokens = 0;
  for (const item of items) {
    const images = imagesOf(item);
    for (const url of images) tokens += imageTokens(url);
    const text = JSON.stringify(item, (key, value: unknown) => (key === "image_url" ? "" : value));
    tokens += Math.ceil(text.length / 4);
  }
  return tokens;
}

function imageTokens(dataUrl: string): number {
  const size = pngSize(dataUrl);
  if (size === undefined) return UNKNOWN_IMAGE_TOKENS;
  const patches = Math.ceil(size.width / 32) * Math.ceil(size.height / 32);
  return Math.ceil(patches * TOKENS_PER_PATCH);
}

/** A PNG's width and height, from the IHDR chunk at the start of its data URL. */
function pngSize(dataUrl: string): { width: number; height: number } | undefined {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return undefined;
  const head = Buffer.from(dataUrl.slice(prefix.length, prefix.length + 32), "base64");
  if (head.length < 24 || head.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}
