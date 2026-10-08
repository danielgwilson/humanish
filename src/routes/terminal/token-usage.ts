// Provider token accounting for the terminal route.
//
// Without these counts, a provider line of `null` with source "unmeasured" would let the no-spend
// proof read `satisfied: true` for `maxUsd: 0` on a run that consumed hundreds of thousands of
// provider tokens, conflating two different states: having no signal at all, and knowing exactly
// how many tokens were spent while lacking a rate to price them.
//
// The counts were already in the bundle. `codex exec --json` emits one usage record per turn:
//   {"type":"turn.completed","usage":{"input_tokens":201536,"cached_input_tokens":170558,
//    "cache_write_input_tokens":30951,"output_tokens":2283,"reasoning_output_tokens":902}}
//
// So the route records a measured token fact whether or not a rate prices it. Rates stay out of this
// module: the route prices these counts once, from the model it passed to Codex, with
// src/run/pricing.ts (live-finish.ts), and the ledger and run.json both read that estimate.

import type { ActorTokenUsage } from "../../actors/contract.js";

/** One `turn.completed` usage record as codex emits it. Every field is optional: a provider that
 *  omits one must leave it undefined rather than reporting 0 (0 and unknown price differently). */
interface RawCodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

// Bounded to a single line on purpose. `[^}]*` would run past a truncated record's missing brace
// and swallow the next, valid record's body, silently dropping a real turn from the count.
const USAGE_RE = /"type"\s*:\s*"turn\.completed"\s*,\s*"usage"\s*:\s*(\{[^}\n]*\})/g;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The usage records in complete stdout lines, kept from output past the transcript cap so
 *  parseTerminalTokenUsage can count them with the stored ones. */
export function terminalUsageRecords(lines: string): string[] {
  return Array.from(lines.matchAll(USAGE_RE), (match) => match[0]);
}

/**
 * Accumulate runtime-turn usage from a captured `codex exec --json` stream. A Codex turn may
 * include multiple provider requests; these records cannot establish per-request pricing tiers.
 *
 * Returns undefined when the stream carried no usage record at all, which is the "no
 * signal" case and must stay distinguishable from a measured zero. Per-turn records are preserved
 * in `turns` because long-context pricing can only be computed from per-request sizes
 * (src/run/pricing.ts), and totals cannot say which requests crossed a threshold.
 */
export function parseTerminalTokenUsage(transcript: string): ActorTokenUsage | undefined {
  const turns: NonNullable<ActorTokenUsage["turns"]> = [];
  for (const match of transcript.matchAll(USAGE_RE)) {
    const body = match[1];
    if (body === undefined) continue;
    let raw: RawCodexUsage;
    try {
      raw = JSON.parse(body) as RawCodexUsage;
    } catch {
      continue; // A truncated or interleaved record is skipped rather than guessed at.
    }
    const input = num(raw.input_tokens);
    const output = num(raw.output_tokens);
    const cachedInput = num(raw.cached_input_tokens);
    const cacheWriteInput = num(raw.cache_write_input_tokens);
    if (input === undefined && output === undefined) continue;
    turns.push({
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(cachedInput === undefined ? {} : { cachedInput }),
      ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
    });
  }
  if (turns.length === 0) return undefined;

  const sum = (
    field: "input" | "output" | "cachedInput" | "cacheWriteInput",
  ): number | undefined => {
    const present = turns.filter((t) => t[field] !== undefined);
    if (present.length === 0) return undefined;
    return present.reduce((acc, t) => acc + (t[field] ?? 0), 0);
  };
  const input = sum("input");
  const output = sum("output");
  const cachedInput = sum("cachedInput");
  const cacheWriteInput = sum("cacheWriteInput");
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
    ...(input === undefined && output === undefined ? {} : { total: (input ?? 0) + (output ?? 0) }),
    turns,
  };
}

/** Human-readable token statement for the cost ledger and the no-spend proof. Reports what was
 *  counted, so a reader never reads "no charge recorded" as "nothing was consumed". */
export function describeTokenUsage(usage: ActorTokenUsage): string {
  const parts: string[] = [];
  if (usage.input !== undefined) parts.push(`${usage.input.toLocaleString("en-US")} input`);
  if (usage.cachedInput !== undefined) {
    parts.push(`${usage.cachedInput.toLocaleString("en-US")} of them cached`);
  }
  if (usage.output !== undefined) parts.push(`${usage.output.toLocaleString("en-US")} output`);
  const turns = usage.turns?.length ?? 0;
  return `${parts.join(", ")} tokens over ${turns} Codex turn${turns === 1 ? "" : "s"}`;
}
