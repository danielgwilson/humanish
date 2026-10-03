import { ACTOR_TRACE_SCHEMA } from "../actors/contract.js";
import type { RunBundle } from "../run/bundle.js";
import { isRecord } from "../run/type-guards.js";

/** Fewer turns with usage than this say nothing about whether the prompt grew. */
const MIN_TURNS = 6;

/**
 * A participant that remembers sends a longer prompt each turn: every turn adds a screenshot and a
 * reply. Over 113 participant traces from live runs (OpenAI computer-use, the Codex participant and
 * the Claude session), the median prompt of the last three turns was at least 1.21 times that of
 * turns 2 to 4. A participant that carries only its last turn stays flat: about 3,100 tokens from
 * turn 2 to turn 527 in one zero-data-retention run, a ratio near 1.0.
 */
const MIN_GROWTH = 1.1;

/**
 * The whole prompt one turn sent. `input` includes the cached parts, except in Claude session
 * traces written before that was fixed, which recorded the uncached part alone; there the cached
 * parts are larger than `input`, and the three are added.
 */
function promptTokens(turn: unknown): number | undefined {
  if (!isRecord(turn) || typeof turn.input !== "number") return undefined;
  const cached = typeof turn.cachedInput === "number" ? turn.cachedInput : 0;
  const written = typeof turn.cacheWriteInput === "number" ? turn.cacheWriteInput : 0;
  return cached + written > turn.input ? turn.input + cached + written : turn.input;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The median prompt of the last three turns over that of turns 2 to 4, from a trace's
 * `tokenUsage.turns`. Turn 1 is left out: it carries the instructions alone. Undefined when fewer
 * than six turns report their input.
 */
export function contextGrowth(turns: readonly unknown[]): number | undefined {
  const sizes = turns.map(promptTokens);
  if (sizes.length < MIN_TURNS || sizes.some((size) => size === undefined)) return undefined;
  const later = (sizes as number[]).slice(1);
  const early = median(later.slice(0, 3));
  return early > 0 ? median(later.slice(-3)) / early : undefined;
}

/** One warning per live participant whose prompt stayed the same size from turn 2 on. */
export function flatContextWarnings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") return [];
  const warnings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (!isRecord(trace) || trace.schema !== ACTOR_TRACE_SCHEMA) continue;
    const turns = isRecord(trace.tokenUsage) ? trace.tokenUsage.turns : undefined;
    if (!Array.isArray(turns)) continue;
    const growth = contextGrowth(turns);
    if (growth === undefined || growth >= MIN_GROWTH) continue;
    const near = Math.round(median(turns.slice(1).map((turn) => promptTokens(turn)!)));
    warnings.push(
      `${stream.id}: its context did not grow. Its prompt stayed near ${near} tokens from turn 2 to turn ${turns.length}, so it likely answered each turn without the earlier ones.`,
    );
  }
  return warnings;
}
