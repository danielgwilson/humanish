import type { ActorTraceItem } from "../../actors/contract.js";
import { normalizeLocalActorTranscript } from "../../run/terminal-contract.js";
import { MESSAGE_CHARS, PENDING_LINE_CHARS, TEXT_ITEMS_BYTES, TEXT_ITEMS_MAX } from "./types.js";

// Analysis may quote message and reasoning items as the participant's own words, so these items
// carry only the agent's text. Command output, usage records and harness lines stay in the
// command's outputTail.

/** What the reader found in the agent's Codex JSON stdout. */
export interface TerminalParticipantText {
  /** Message and reasoning items, the most recent kept under the aggregate limits, then a notice
   *  when older ones were left out. */
  items: ActorTraceItem[];
  /** Distinct agent_message items in the stream, kept or not. */
  messages: number;
  /** Distinct participant items: messages, reasoning, commands, web searches and file changes.
   *  Lifecycle, usage, launcher diagnostics and nested command output are not activity. Zero
   *  means no recognized item was retained, not that the participant succeeded. */
  participantItems: number;
}

const itemEvents = new Set(["item.started", "item.updated", "item.completed"]);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Each Codex item event in a run of complete JSON lines, in stream order. */
function* codexStreamItems(
  lines: string,
): Generator<{ event: string; id: string; item: Record<string, unknown> }> {
  for (const line of lines.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !object(event) ||
      typeof event.type !== "string" ||
      !itemEvents.has(event.type) ||
      !object(event.item) ||
      !nonempty(event.item.id)
    )
      continue;
    yield { event: event.type, id: event.item.id, item: event.item };
  }
}

function isParticipantItem(item: Record<string, unknown>): boolean {
  return (
    ((item.type === "agent_message" || item.type === "reasoning") && nonempty(item.text)) ||
    (item.type === "command_execution" && nonempty(item.command)) ||
    (item.type === "web_search" &&
      (nonempty(item.query) || (object(item.action) && nonempty(item.action.type)))) ||
    (item.type === "file_change" &&
      Array.isArray(item.changes) &&
      item.changes.some(
        (change) => object(change) && nonempty(change.path) && nonempty(change.kind),
      ))
  );
}

// The verdict parser removes all whitespace before matching, so a line is a marker line when its
// whitespace-free form names either marker. The parser reads the stored stream, not these items.
const MARKER = /HUMANISH_ACTOR_(?:VERDICT|NONCE)=/i;
const withoutMarkerLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !MARKER.test(line.replace(/\s+/g, "")))
    .join("\n");

/**
 * Read participant text from the raw stdout as the recorder receives it. Source redaction runs on
 * the stored stream and can cut through JSON framing (a redacted URL takes the closing quote with
 * it), so each line is parsed here, in memory, and only decoded text that has passed `sanitize`
 * is kept. The raw bytes are never stored.
 */
export function createTerminalParticipantReader(sanitize: (text: string) => string): {
  append(raw: string): void;
  finish(): TerminalParticipantText;
} {
  let pending = "";
  // Set while the rest of an over-long line is skipped, up to its newline.
  let skipping = false;
  let droppedLines = 0;
  const participantIds = new Set<string>();
  const messageIds = new Set<string>();
  const done = new Set<string>();
  // Completed or left-out items; later events for them are ignored.
  const closed = new Set<string>();
  const texts = new Map<string, { kind: "message" | "reasoning"; number: number; text: string }>();
  const numbers = { message: 0, reasoning: 0 };
  let left = 0;
  let result: TerminalParticipantText | undefined;

  const take = (lines: string): void => {
    for (const { event, id, item } of codexStreamItems(normalizeLocalActorTranscript(lines))) {
      if (isParticipantItem(item)) participantIds.add(id);
      const kind =
        item.type === "agent_message" ? "message" : item.type === "reasoning" ? "reasoning" : null;
      if (kind === null || !nonempty(item.text) || closed.has(id)) continue;
      if (kind === "message") messageIds.add(id);
      if (event === "item.completed") {
        done.add(id);
        closed.add(id);
      }
      // Redact the decoded text before cutting it, so a cut cannot split a value past the patterns.
      const clean = [...sanitize(withoutMarkerLines(item.text))];
      const text = (clean.length > MESSAGE_CHARS ? clean.slice(0, MESSAGE_CHARS) : clean).join("");
      const previous = texts.get(id);
      if (!text.trim()) {
        texts.delete(id);
        continue;
      }
      texts.set(id, { kind, number: previous?.number ?? ++numbers[kind], text });
      // The oldest item beyond the count limit is left out as the stream arrives, finished or not,
      // so a long stream cannot hold every message in memory.
      if (texts.size > TEXT_ITEMS_MAX) {
        const oldest = texts.keys().next().value!;
        texts.delete(oldest);
        closed.add(oldest);
        left += 1;
      }
    }
  };

  return {
    append(raw) {
      if (result) return;
      if (skipping) {
        const end = raw.indexOf("\n");
        if (end < 0) return;
        skipping = false;
        raw = raw.slice(end + 1);
      }
      pending += raw;
      const end = pending.lastIndexOf("\n");
      if (end >= 0) {
        take(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      // A line with no newline in sight is dropped, so one runaway line cannot grow without bound.
      if (pending.length > PENDING_LINE_CHARS) {
        pending = "";
        skipping = true;
        droppedLines += 1;
      }
    },
    finish() {
      if (result) return result;
      if (!skipping) take(pending);
      pending = "";
      const entries = [...texts.entries()];
      let start = entries.length;
      let bytes = 0;
      while (start > 0 && entries.length - start < TEXT_ITEMS_MAX) {
        const size = Buffer.byteLength(entries[start - 1]![1].text);
        if (bytes + size > TEXT_ITEMS_BYTES) break;
        bytes += size;
        start -= 1;
      }
      left += start;
      const kept = entries.slice(start);
      const items = kept.map(([source, { kind, number, text }]): ActorTraceItem => ({
        id: `${kind}-${String(number).padStart(3, "0")}`,
        kind,
        lifecycle: done.has(source) ? "completed" : "started",
        title: kind === "message" ? "agent message" : "agent reasoning",
        text,
      }));
      const notices: Array<[string, string]> = [];
      if (left > 0)
        notices.push([
          "agent text truncated",
          `Kept the last ${kept.length} of ${kept.length + left} agent message and reasoning items, within ${TEXT_ITEMS_MAX} items and ${TEXT_ITEMS_BYTES / 1024} KiB. The terminal transcript keeps the captured stream.`,
        ]);
      if (droppedLines > 0)
        notices.push([
          "agent output lines skipped",
          `Skipped ${droppedLines} stdout line(s) that ran past ${PENDING_LINE_CHARS} characters without a newline. Items on those lines are not in this trace or its counts.`,
        ]);
      notices.forEach(([title, text], index) =>
        items.push({
          id: `notice-${String(index + 1).padStart(3, "0")}`,
          kind: "notice",
          lifecycle: "completed",
          status: "truncated",
          title,
          text,
        }),
      );
      result = { items, messages: messageIds.size, participantItems: participantIds.size };
      return result;
    },
  };
}
