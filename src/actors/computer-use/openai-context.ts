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
// When the estimate passes the budget, the opening screenshot goes first, then the oldest
// exchanges become lines of a progress note that keeps their reasoning summaries, messages and
// actions as text. The newest MIN_KEPT_EXCHANGES exchanges are never collapsed.

/** The estimated input a carried conversation may reach before its oldest turns are summarized. */
export const CONTEXT_TOKEN_BUDGET = 64_000;
/** Exchanges always carried whole, so the model sees its latest actions with their screens. */
const MIN_KEPT_EXCHANGES = 2;
/** The progress note's length cap; past it, the oldest lines are counted instead of shown. */
const NOTE_CHAR_LIMIT = 16_000;
/** A screenshot whose size cannot be read is estimated at the image token cap. */
const UNKNOWN_IMAGE_TOKENS = 1_600;

interface CarriedExchange {
  /** The request number whose reply produced `output` (1 for the opening request). */
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
  private readonly notes: string[] = [];
  private notesDropped = 0;
  private collapsedTurns = 0;

  constructor(private readonly budget = CONTEXT_TOKEN_BUDGET) {}

  /** Exchanges summarized into the progress note so far. */
  get collapsed(): number {
    return this.collapsedTurns;
  }

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
    while (estimateTokens(this.carried()) > this.budget) {
      if (this.opening !== undefined && imagesOf(this.opening).length > 0) {
        this.opening = withoutImages(this.opening);
        continue;
      }
      if (this.exchanges.length <= MIN_KEPT_EXCHANGES) return;
      const oldest = this.exchanges.shift()!;
      this.notes.push(describeExchange(oldest));
      this.collapsedTurns += 1;
      while (this.notes.join("\n").length > NOTE_CHAR_LIMIT && this.notes.length > 1) {
        this.notes.shift();
        this.notesDropped += 1;
      }
    }
  }

  private noteItem(): Record<string, unknown> | undefined {
    if (this.notes.length === 0) return undefined;
    const lead =
      `Your earlier turns in this session, oldest first. Their screenshots are no longer shown; ` +
      `this is what you thought, said and did.` +
      (this.notesDropped === 0 ? "" : ` (${this.notesDropped} earlier turns are not listed.)`);
    return inputMessage("developer", [
      { type: "input_text", text: `${lead}\n${this.notes.join("\n")}` },
    ]);
  }
}

/** One exchange as a progress-note line: its reasoning summary, message and actions. */
function describeExchange(exchange: CarriedExchange): string {
  const thought: string[] = [];
  const said: string[] = [];
  const did: string[] = [];
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
    did.length > 0 ? `did: ${did.join(", ")}` : undefined,
  ].filter((part) => part !== undefined);
  return `Turn ${exchange.turn}: ${parts.length > 0 ? parts.join("; ") : "no recorded output"}.`;
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
 * A rough input-token estimate: images by their size in 32-pixel patches (the cap is the
 * model's per-image limit), everything else at four characters a token. It decides when to
 * trim, not what is billed; the trace records the billed input per request beside it.
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
  return Math.min(patches, 1_536) + 85;
}

/** A PNG's width and height, from the IHDR chunk at the start of its data URL. */
function pngSize(dataUrl: string): { width: number; height: number } | undefined {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return undefined;
  const head = Buffer.from(dataUrl.slice(prefix.length, prefix.length + 32), "base64");
  if (head.length < 24 || head.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}
