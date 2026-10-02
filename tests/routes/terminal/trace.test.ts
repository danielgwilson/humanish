import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactText, scrubLiterals } from "../../../src/evidence/redaction.js";
import { createTerminalParticipantReader } from "../../../src/routes/terminal/participant-text.js";
import { createTerminalRecorder } from "../../../src/routes/terminal/recorder.js";
import {
  MESSAGE_CHARS,
  TEXT_ITEMS_BYTES,
  TEXT_ITEMS_MAX,
} from "../../../src/routes/terminal/types.js";

const wire = readFileSync(
  new URL("../../fixtures/terminal-runtime/participant-items.ndjson", import.meta.url),
  "utf8",
);
const records = wire.trim().split("\n");
const message = JSON.parse(records[0]!);
const command = JSON.parse(records[2]!);
const line = (event: unknown): string => JSON.stringify(event);
const said = (text: string, id = message.item.id): string =>
  line({ ...message, item: { ...message.item, id, text } });

function read(stdout: string, sanitize = (text: string): string => text) {
  const reader = createTerminalParticipantReader(sanitize);
  reader.append(stdout);
  return reader.finish();
}

describe("terminal participant activity", () => {
  it("counts captured item shapes and deduplicates one command across its lifecycle", () => {
    expect(read(wire).participantItems).toBe(4);
    expect(read(records.slice(1, 3).join("\n")).participantItems).toBe(1);
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
    expect(read(setup.join("\n")).participantItems).toBe(0);
  });

  it("requires meaningful content and never promotes malformed or nested records", () => {
    const stdout = [
      said("  "),
      line({ ...command, item: { ...command.item, command: "" } }),
      said("text", ""),
      line({ ...message, type: "unknown.event" }),
      line({ ...message, item: { ...message.item, type: "unknown_item" } }),
      line({ diagnostic: message }),
      line(records[0]),
      "null",
      "[]",
      "{}",
      records[0]!.slice(0, -2),
    ].join("\n");
    expect(read(stdout)).toEqual({ items: [], messages: 0, participantItems: 0 });
  });

  it("finds an early item even when later output exceeds the display tail", () => {
    expect(read(`${records[1]}\n${"synthetic diagnostic\n".repeat(5000)}`).participantItems).toBe(
      1,
    );
  });

  it("reads a line split across deliveries", () => {
    const reader = createTerminalParticipantReader((text) => text);
    const stdout = `${said("Split across two chunks.")}\n`;
    reader.append(stdout.slice(0, 30));
    reader.append(stdout.slice(30));
    expect(reader.finish().items.map((item) => item.text)).toEqual(["Split across two chunks."]);
  });
});

describe("terminal participant text items", () => {
  it("decodes the agent's own text and leaves command output and usage out", () => {
    const text = 'Ran the CLI.\nIt printed "ok" twice.';
    const output = '{\n  "status": "share_ready"\n}\n';
    const stdout = [
      line({ ...command, item: { ...command.item, aggregated_output: output } }),
      said(text),
      '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
    ].join("\n");
    expect(read(stdout).items).toEqual([
      { id: "message-001", kind: "message", lifecycle: "completed", title: "agent message", text },
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
    expect(read(stdout).items.map(({ id, lifecycle, text }) => ({ id, lifecycle, text }))).toEqual([
      { id: "message-001", lifecycle: "completed", text: "final" },
      { id: "reasoning-001", lifecycle: "completed", text: "Checking the help output." },
      { id: "message-002", lifecycle: "started", text: "cut off" },
    ]);
  });

  it("re-applies the sanitizer to decoded text, then bounds each item", () => {
    // The stream escapes the quote, so a scrub of the raw stream cannot match this value.
    const value = 'synthetic"value';
    const sanitize = (text: string): string => text.replaceAll(value, "[REDACTED_SECRET]");
    const [item] = read(said(`${value} ${"x".repeat(MESSAGE_CHARS)}`), sanitize).items;
    expect(item?.text?.startsWith("[REDACTED_SECRET] x")).toBe(true);
    expect(item?.text).toHaveLength(MESSAGE_CHARS);
  });

  it("strips harness marker lines from the agent's text", () => {
    const stdout = [
      said("Done.\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=12345678-123", "a"),
      said("Blocked on a key.\nhumanish_actor_verdict = blocked  humanish_actor_nonce=x", "b"),
      said("HUMANISH_ACTOR_VERDICT=failed\nHUMANISH_ACTOR_NONCE=12345678-123", "c"),
    ].join("\n");
    const result = read(stdout);
    expect(result.items.map((item) => item.text)).toEqual(["Done.", "Blocked on a key."]);
    expect(result.messages).toBe(3);
  });

  it("reads messages whose stored, redacted line is no longer JSON", () => {
    const key = "synthetic-known-value-0123456789";
    const sanitize = (text: string): string => redactText(scrubLiterals([key])(text));
    // Built from parts so the public-surface scan does not read it as a real credential URL.
    const database = "postgres:" + "//user:synthetic" + "@db.example/database";
    const recorder = createTerminalRecorder({
      nowIso: () => "2026-10-02T00:00:00.000Z",
      sanitize,
      knownSecretValues: [key],
    });
    const stdout = [
      said("Try https://e2b.example/test", "a"),
      said(`Use ${database}`, "b"),
      said(`The key is ${key}`, "c"),
    ].join("\n");
    // Split inside the known value, so neither stored chunk holds it whole.
    const cut = stdout.indexOf(key) + 8;
    recorder.recordStreamedTerminalChunk("stdout", stdout.slice(0, cut));
    recorder.recordStreamedTerminalChunk("stdout", `${stdout.slice(cut)}\n`);
    const items = recorder.participantText.finish().items;
    expect(items.map((item) => item.text)).toEqual([
      sanitize("Try https://e2b.example/test"),
      sanitize(`Use ${database}`),
      "The key is [REDACTED_SECRET]",
    ]);
    expect(JSON.stringify(items)).not.toContain(key);
    expect(JSON.stringify(items)).not.toContain("synthetic@");
  });

  it("keeps the most recent items within the aggregate limits and notes the cut", () => {
    const many = (count: number, size: number): string =>
      Array.from({ length: count }, (_, index) => said("x".repeat(size), `m${index}`)).join("\n");
    const bulk = read(many(6000, 3000));
    expect(bulk.messages).toBe(6000);
    const kept = bulk.items.filter((item) => item.kind === "message");
    expect(kept.length).toBeLessThanOrEqual(TEXT_ITEMS_MAX);
    expect(kept.reduce((bytes, item) => bytes + Buffer.byteLength(item.text!), 0)).toBeLessThan(
      TEXT_ITEMS_BYTES,
    );
    expect(kept.at(-1)?.id).toBe("message-6000");
    expect(bulk.items.at(-1)).toMatchObject({ kind: "notice", status: "truncated" });

    const byCount = read(many(TEXT_ITEMS_MAX + 50, 10)).items;
    expect(byCount.filter((item) => item.kind === "message")).toHaveLength(TEXT_ITEMS_MAX);
    expect(byCount[0]?.id).toBe("message-051");

    expect(read(many(3, 10)).items.some((item) => item.kind === "notice")).toBe(false);
  });
});
