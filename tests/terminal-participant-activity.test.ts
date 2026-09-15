import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countTerminalParticipantItems } from "../src/terminal-participant-activity.js";

const wire = readFileSync(new URL("./fixtures/terminal-runtime/participant-items.ndjson", import.meta.url), "utf8");
const records = wire.trim().split("\n");

describe("terminal participant activity", () => {
  it("counts captured item shapes and deduplicates one command across its lifecycle", () => {
    expect(countTerminalParticipantItems(wire)).toBe(4);
    expect(countTerminalParticipantItems(records.slice(1, 3).join("\n"))).toBe(1);
  });

  it("rejects launcher diagnostics and runtime lifecycle or usage records", () => {
    // Lifecycle/usage shapes are captured in the terminal token-usage suite;
    // only the ID and usage values below are neutral substitutions.
    const setup = ["npm error synthetic launcher unavailable", '{"type":"thread.started","thread_id":"synthetic-thread"}',
      '{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'];
    expect(countTerminalParticipantItems(setup.join("\n"))).toBe(0);
  });

  it("requires meaningful content and never promotes malformed or nested records", () => {
    const message = JSON.parse(records[0]!);
    const command = JSON.parse(records[1]!);
    expect(countTerminalParticipantItems([
      JSON.stringify({ ...message, item: { ...message.item, text: "  " } }),
      JSON.stringify({ ...command, item: { ...command.item, command: "" } }),
      JSON.stringify({ ...message, item: { ...message.item, id: "" } }),
      JSON.stringify({ ...message, type: "unknown.event" }),
      JSON.stringify({ ...message, item: { ...message.item, type: "unknown_item" } }),
      JSON.stringify({ diagnostic: message }), JSON.stringify(records[0]),
      "null", "[]", "{}", records[0]!.slice(0, -2)
    ].join("\n"))).toBe(0);
  });

  it("finds an early item even when later output exceeds the display tail", () => {
    expect(countTerminalParticipantItems(`${records[1]}\n${"synthetic diagnostic\n".repeat(5000)}`)).toBe(1);
  });
});
