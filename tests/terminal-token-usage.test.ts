import { describe, expect, it } from "vitest";
import { describeTokenUsage, parseTerminalTokenUsage } from "../src/terminal-token-usage.js";

// Real records, copied from a live last-mile run on 2026-09-01.
const TURN_1 =
  '{"type":"turn.completed","usage":{"input_tokens":201536,"cached_input_tokens":170558,'
  + '"cache_write_input_tokens":30951,"output_tokens":2283,"reasoning_output_tokens":902}}';
const TURN_2 =
  '{"type":"turn.completed","usage":{"input_tokens":201536,"cached_input_tokens":100000,'
  + '"cache_write_input_tokens":1000,"output_tokens":2283}}';

describe("terminal token usage", () => {
  it("returns undefined when the stream carried no usage record", () => {
    // The honest no-signal case. It must stay distinct from a measured zero.
    expect(parseTerminalTokenUsage("no usage here\n{\"type\":\"item.completed\"}")).toBeUndefined();
  });

  it("accumulates totals and keeps per-turn records", () => {
    const usage = parseTerminalTokenUsage(`${TURN_1}\n${TURN_2}\n`);
    expect(usage).toBeDefined();
    expect(usage?.input).toBe(403072);
    expect(usage?.output).toBe(4566);
    expect(usage?.cachedInput).toBe(270558);
    expect(usage?.cacheWriteInput).toBe(31951);
    expect(usage?.total).toBe(407638);
    // Per-turn records survive: long-context pricing can only be computed from request sizes.
    expect(usage?.turns).toHaveLength(2);
    expect(usage?.turns?.[0]?.input).toBe(201536);
  });

  it("omits a field the provider did not report rather than reporting zero", () => {
    const usage = parseTerminalTokenUsage('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}');
    expect(usage?.input).toBe(10);
    // 0 and "unknown" price very differently, so an absent field stays absent.
    expect(usage?.cachedInput).toBeUndefined();
    expect(usage?.cacheWriteInput).toBeUndefined();
  });

  it("skips a truncated record instead of guessing at it", () => {
    const usage = parseTerminalTokenUsage(`{"type":"turn.completed","usage":{"input_toke\n${TURN_2}`);
    expect(usage?.turns).toHaveLength(1);
    expect(usage?.input).toBe(201536);
  });

  it("ignores a usage record carrying neither input nor output", () => {
    const usage = parseTerminalTokenUsage('{"type":"turn.completed","usage":{"reasoning_output_tokens":5}}');
    expect(usage).toBeUndefined();
  });

  it("describes what was counted without implying a price", () => {
    const usage = parseTerminalTokenUsage(`${TURN_1}\n${TURN_2}`);
    const text = describeTokenUsage(usage!);
    expect(text).toContain("403,072 input");
    expect(text).toContain("270,558 of them cached");
    expect(text).toContain("4,566 output");
    expect(text).toContain("2 Codex turns");
    // No dollar figure is invented anywhere in the statement.
    expect(text).not.toContain("$");
  });
});
