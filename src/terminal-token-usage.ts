// Provider token accounting for the terminal lane (#531).
//
// THE GAP THIS CLOSES. A live terminal run reported `cost.lines.provider = null` with source
// "unmeasured", and the no-spend proof then read `satisfied: true` for `maxUsd: 0` on a run that
// had demonstrably consumed hundreds of thousands of provider tokens. The statement was honest
// (it listed provider as unmeasured) but it conflated two very different states: having no signal
// at all, and knowing exactly how many tokens were spent while lacking a rate to price them.
//
// The counts were already in the bundle. `codex exec --json` emits one usage record per turn:
//   {"type":"turn.completed","usage":{"input_tokens":201536,"cached_input_tokens":170558,
//    "cache_write_input_tokens":30951,"output_tokens":2283,"reasoning_output_tokens":902}}
//
// So the lane can record a MEASURED token fact even when it cannot record a priced one. Rates stay
// out of this module deliberately: pricing lives in src/pricing.ts, and the terminal lane has no
// real model id to price against (it records `model: "codex"`), so the honest output is
// tokens-known-rate-unknown rather than a guessed dollar figure.

import type { ActorTokenUsage } from "./actor-contract.js";

/** One `turn.completed` usage record as codex emits it. Every field is optional: a provider that
 *  omits one must leave it undefined rather than reporting 0 (0 and unknown price differently). */
interface RawCodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

// Bounded to a single line on purpose. `[^}]*` would run past a TRUNCATED record's missing brace
// and swallow the next, valid record's body, silently dropping a real turn from the count.
const USAGE_RE = /"type"\s*:\s*"turn\.completed"\s*,\s*"usage"\s*:\s*(\{[^}\n]*\})/g;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Accumulate runtime-turn usage from a captured `codex exec --json` stream. A Codex turn may
 * include multiple provider requests; these records cannot establish per-request pricing tiers.
 *
 * Returns undefined when the stream carried no usage record at all, which is the honest "no
 * signal" case and must stay distinguishable from a measured zero. Per-turn records are preserved
 * in `turns` because long-context pricing can only be computed from per-request sizes
 * (src/pricing.ts), and totals cannot say which requests crossed a threshold.
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
      ...(cacheWriteInput === undefined ? {} : { cacheWriteInput })
    });
  }
  if (turns.length === 0) return undefined;

  const sum = (field: "input" | "output" | "cachedInput" | "cacheWriteInput"): number | undefined => {
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
    turns
  };
}

/** Human-readable token statement for the cost ledger and the no-spend proof. Reports what was
 *  counted and says plainly that it is unpriced, so a reader never reads "no charge recorded" as
 *  "nothing was consumed". */
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
