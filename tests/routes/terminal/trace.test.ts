import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  countTerminalParticipantItems,
  terminalParticipantTextItems,
} from "../../../src/routes/terminal/trace.js";
import { MESSAGE_CHARS } from "../../../src/routes/terminal/types.js";

const wire = readFileSync(
  new URL("../../fixtures/terminal-runtime/participant-items.ndjson", import.meta.url),
  "utf8",
);
const records = wire.trim().split("\n");

describe("terminal participant activity", () => {
  it("counts captured item shapes and deduplicates one command across its lifecycle", () => {
    expect(countTerminalParticipantItems(wire)).toBe(4);
    expect(countTerminalParticipantItems(records.slice(1, 3).join("\n"))).toBe(1);
  });

  it("rejects launcher diagnostics and runtime lifecycle or usage records", () => {
    // Lifecycle/usage shapes are captured in the terminal token-usage suite;
    // only the ID and usage values below are neutral substitutions.
    const setup = [
      "npm error synthetic launcher unavailable",
      '{"type":"thread.started","thread_id":"synthetic-thread"}',
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
    ];
    expect(countTerminalParticipantItems(setup.join("\n"))).toBe(0);
  });

  it("requires meaningful content and never promotes malformed or nested records", () => {
    const message = JSON.parse(records[0]!);
    const command = JSON.parse(records[1]!);
    expect(
      countTerminalParticipantItems(
        [
          JSON.stringify({ ...message, item: { ...message.item, text: "  " } }),
          JSON.stringify({ ...command, item: { ...command.item, command: "" } }),
          JSON.stringify({ ...message, item: { ...message.item, id: "" } }),
          JSON.stringify({ ...message, type: "unknown.event" }),
          JSON.stringify({ ...message, item: { ...message.item, type: "unknown_item" } }),
          JSON.stringify({ diagnostic: message }),
          JSON.stringify(records[0]),
          "null",
          "[]",
          "{}",
          records[0]!.slice(0, -2),
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("finds an early item even when later output exceeds the display tail", () => {
    expect(
      countTerminalParticipantItems(`${records[1]}\n${"synthetic diagnostic\n".repeat(5000)}`),
    ).toBe(1);
  });
});

describe("terminal participant text items", () => {
  const message = JSON.parse(records[0]!);
  const command = JSON.parse(records[2]!);
  const line = (event: unknown): string => JSON.stringify(event);
  const keep = (text: string): string => text;

  it("decodes the agent's own text and leaves command output and usage out", () => {
    const said = 'Ran the CLI.\nIt printed "ok" twice.';
    const output = '{\n  "status": "share_ready"\n}\n';
    const stdout = [
      line({ ...command, item: { ...command.item, aggregated_output: output } }),
      line({ ...message, item: { ...message.item, text: said } }),
      '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
      "HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=synthetic",
    ].join("\n");
    expect(terminalParticipantTextItems(stdout, keep)).toEqual([
      {
        id: "message-001",
        kind: "message",
        lifecycle: "completed",
        title: "agent message",
        text: said,
      },
    ]);
  });

  it("keeps one item per id in stream order, with its completed text", () => {
    const item = (event: string, id: string, type: string, text: string): string =>
      line({ type: event, item: { id, type, text } });
    const stdout = [
      item("item.started", "a", "agent_message", "draft"),
      item("item.completed", "r", "reasoning", "Checking the help output."),
      item("item.completed", "a", "agent_message", "final"),
      item("item.updated", "a", "agent_message", "late"),
      item("item.started", "b", "agent_message", "cut off"),
    ].join("\n");
    expect(
      terminalParticipantTextItems(stdout, keep).map(({ id, lifecycle, text }) => ({
        id,
        lifecycle,
        text,
      })),
    ).toEqual([
      { id: "message-001", lifecycle: "completed", text: "final" },
      { id: "reasoning-001", lifecycle: "completed", text: "Checking the help output." },
      { id: "message-002", lifecycle: "started", text: "cut off" },
    ]);
  });

  it("re-applies the route sanitizer to decoded text, then bounds it", () => {
    // The stream escapes the quote, so a scrub of the raw stream cannot match this value.
    const value = 'synthetic"value';
    const sanitize = (text: string): string => text.replaceAll(value, "[REDACTED_SECRET]");
    const long = `${value} ${"x".repeat(MESSAGE_CHARS)}`;
    const [item] = terminalParticipantTextItems(
      line({ ...message, item: { ...message.item, text: long } }),
      sanitize,
    );
    expect(item?.text?.startsWith("[REDACTED_SECRET] x")).toBe(true);
    expect(item?.text).toHaveLength(MESSAGE_CHARS);
  });

  it("ignores blank, malformed and nested records", () => {
    const stdout = [
      line({ ...message, item: { ...message.item, text: "  " } }),
      line({ ...message, item: { ...message.item, id: "" } }),
      line({ diagnostic: message }),
      line(records[0]),
      records[0]!.slice(0, -2),
    ].join("\n");
    expect(terminalParticipantTextItems(stdout, keep)).toEqual([]);
  });
});
