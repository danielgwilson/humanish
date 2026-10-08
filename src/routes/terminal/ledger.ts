import { describeTokenUsage } from "./token-usage.js";
import type { ActorTokenUsage, ActorTrace } from "../../actors/contract.js";
import type { StudyCaps } from "../../study/types.js";
import { round6 } from "../../run/pricing.js";
import { COST_CATEGORIES, type CostCategory } from "../../run/terminal-contract.js";
import type { CostLine, NoSpendProof, TerminalCostLedger } from "./types.js";

/**
 * Build the spend ledger from the captured session. The null discipline:
 *   - The `provider` line has no measured charge, so its `usd` is null. When the trace's
 *     `estimatedCost` prices its tokens, the line carries that price as `estimatedUsd`: the figure
 *     run.json's model-tokens line gives, from the same object. Tokens with no rate, and a run
 *     with no token count, stay null with the reason in the note.
 *   - product/media/payment are `null` by default: core has no signal for those categories, and
 *     only a test can supply one, through `StudyDeps.costProbe`.
 * `injectedLines` lets a test supply known spend for a category,
 * exercising the fail-closed cap enforcement deterministically without a real billable run.
 */
export function buildCostLedger(args: {
  trace: Pick<ActorTrace, "tokenUsage" | "estimatedCost">;
  injectedLines?: Partial<Record<CostCategory, CostLine>>;
}): TerminalCostLedger {
  const lines: Record<CostCategory, CostLine> = {
    product: args.injectedLines?.product ?? unmeasured("product"),
    media: args.injectedLines?.media ?? unmeasured("media"),
    payment: args.injectedLines?.payment ?? unmeasured("payment"),
    provider: args.injectedLines?.provider ?? providerLine(args.trace),
  };

  // knownTotalUsd sums only the non-null lines. A null line contributes nothing and is never
  // coerced to 0 (that would let an unmeasured category masquerade as a measured zero).
  let knownTotalUsd = 0;
  let fullyMeasured = true;
  for (const category of COST_CATEGORIES) {
    const usd = lines[category].usd;
    if (usd === null) {
      fullyMeasured = false;
    } else {
      knownTotalUsd += usd;
    }
  }
  return {
    schema: "humanish.terminal-cost-ledger.v1",
    currency: "usd",
    lines,
    knownTotalUsd: round6(knownTotalUsd),
    fullyMeasured,
  };
}

function unmeasured(category: CostCategory): CostLine {
  return {
    usd: null,
    count: null,
    source: "unmeasured",
    note: `${category} spend not measured: humanish has no ${category} spend signal, and a study cannot supply one. Recorded as null, never guessed as 0.`,
  };
}

/** The participant's model tokens: estimated from the trace's price, unpriced, or not counted. */
function providerLine(trace: Pick<ActorTrace, "tokenUsage" | "estimatedCost">): CostLine {
  const { tokenUsage, estimatedCost } = trace;
  if (tokenUsage === undefined)
    return {
      usd: null,
      source: "unmeasured",
      note: "Provider spend not measured: the participant's output carried no token usage in this run, so it is recorded as null and not guessed as 0.",
    };
  if (estimatedCost !== undefined && estimatedCost.estimatedCostUsd !== null)
    return {
      usd: null,
      estimatedUsd: estimatedCost.estimatedCostUsd,
      source: "estimated-token-usage",
      note:
        `Provider spend estimated at ${estimatedCost.estimatedCostUsd} USD: the run consumed ` +
        `${describeTokenUsage(tokenUsage)}, priced at ${estimatedCost.modelId ?? "the participant model's"} ` +
        `rates as of ${estimatedCost.ratesAsOf}, as run.json's cost summary prices them. No provider ` +
        "charge was measured, so usd stays null and caps.maxUsd does not count the estimate.",
    };
  // Tokens counted, no rate to price them. A guessed dollar figure would be worse than none, but
  // the note carries the measured fact so a reader never mistakes "no charge recorded" for
  // "nothing was consumed".
  return {
    usd: null,
    source: "unpriced-token-usage",
    note:
      `Provider spend unpriced: the run consumed ${describeTokenUsage(tokenUsage)}, but humanish ` +
      `has no rate for ${estimatedCost?.modelId === undefined ? "the participant's model" : `the model ${estimatedCost.modelId}`}, ` +
      "so no dollar figure is given. The token count is measured; the price is not known. " +
      "Recorded as null, never guessed as 0.",
  };
}

/** True when no cost line carries a dollar value, so a no-spend proof has nothing to stand on. */
export function noSpendLineMeasured(
  proof: Pick<NoSpendProof, "knownZeroLines" | "knownNonZeroLines">,
): boolean {
  return proof.knownZeroLines.length + proof.knownNonZeroLines.length === 0;
}

/**
 * The verdict for an all-null ledger. `satisfied` stays true there (no known line exceeds the
 * cap), so the words must say the proof was not established rather than passed.
 */
export function noSpendNotEstablished(maxUsd: number): string {
  return `No-spend proof not established for maxUsd=${maxUsd}: no spend line was measured.`;
}

/**
 * What the ledger measured, in words: the dollar lines it knows, the provider tokens it counted
 * with their estimate or as unpriced, and the lines it has no signal for. A reader of a maxUsd=0
 * run must not take an all-null ledger for a proven $0.
 */
export function describeMeasuredSpend(
  ledger: TerminalCostLedger,
  tokenUsage?: ActorTokenUsage,
): string {
  const measured = COST_CATEGORIES.filter((c) => ledger.lines[c].usd !== null).map(
    (c) => `${c} ${ledger.lines[c].usd} USD`,
  );
  const provider = ledger.lines.provider;
  const countedProvider =
    provider.usd === null &&
    (provider.source === "unpriced-token-usage" || provider.source === "estimated-token-usage");
  const unmeasured = COST_CATEGORIES.filter(
    (c) => ledger.lines[c].usd === null && !(c === "provider" && countedProvider),
  );
  const counts = tokenUsage === undefined ? "" : ` (${describeTokenUsage(tokenUsage)})`;
  return [
    measured.length > 0 ? `Measured: ${measured.join(", ")}.` : "",
    !countedProvider
      ? ""
      : provider.estimatedUsd === undefined
        ? `Provider tokens were consumed${counts} and are unpriced, not zero.`
        : `Provider tokens${counts} are estimated at ${provider.estimatedUsd} USD, the participant's model cost, which caps.maxUsd does not count.`,
    unmeasured.length > 0 ? `Not measured (null, not claimed zero): ${unmeasured.join(", ")}.` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Derive the no-spend proof from the ledger. It vouches for known-zero lines and
 *  explicitly lists the unmeasured (null) lines it cannot vouch for. It never claims zero on null. */
export function buildNoSpendProof(
  ledger: TerminalCostLedger,
  maxUsd: number | null,
  tokenUsage?: ActorTokenUsage,
): NoSpendProof {
  const knownZeroLines: CostCategory[] = [];
  const knownNonZeroLines: CostCategory[] = [];
  const unmeasuredLines: CostCategory[] = [];
  for (const category of COST_CATEGORIES) {
    const usd = ledger.lines[category].usd;
    if (usd === null) unmeasuredLines.push(category);
    else if (usd === 0) knownZeroLines.push(category);
    else knownNonZeroLines.push(category);
  }
  // satisfied only when every known line is within the cap (for a no-spend run, maxUsd 0 => every
  // known line must be exactly 0). Unmeasured lines never make it satisfied; they are reported
  // separately as the proof's blind spot.
  const cap = maxUsd ?? 0;
  const satisfied = knownNonZeroLines.length === 0 && ledger.knownTotalUsd <= cap;
  const verdict = !satisfied
    ? `No-spend proof not satisfied for maxUsd=${cap}: known spend total ${ledger.knownTotalUsd} USD${knownNonZeroLines.length > 0 ? ` (non-zero: ${knownNonZeroLines.join(", ")})` : ""}.`
    : noSpendLineMeasured({ knownZeroLines, knownNonZeroLines })
      ? noSpendNotEstablished(cap)
      : `No-spend proof satisfied for maxUsd=${cap} on the measured lines (known total ${ledger.knownTotalUsd} USD).`;
  const statement = [verdict, describeMeasuredSpend(ledger, tokenUsage)]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    schema: "humanish.terminal-no-spend-proof.v1",
    maxUsd,
    satisfied,
    knownZeroLines,
    knownNonZeroLines,
    unmeasuredLines,
    knownTotalUsd: ledger.knownTotalUsd,
    statement,
  };
}

/**
 * Fail-closed caps enforcement. Returns a structured violation when a known
 * (measured) spend line exceeds maxUsd, or a known billable-job count exceeds maxJobs. Unknowns
 * (`null`) never trip the cap (we cannot claim a violation we did not measure), and they also never
 * grant a green pass: the no-spend proof reports them as unmeasured. maxMinutes is wall-clock and is
 * enforced separately (runWithWallClock); it is not a ledger-derived cap.
 */
export function evaluateCapsAgainstLedger(
  ledger: TerminalCostLedger,
  caps: StudyCaps,
): { ok: true } | { ok: false; message: string } {
  if (caps.maxUsd !== undefined && ledger.knownTotalUsd > caps.maxUsd) {
    const overLines = COST_CATEGORIES.filter(
      (c) => ledger.lines[c].usd !== null && (ledger.lines[c].usd as number) > 0,
    );
    return {
      ok: false,
      message: `Stopped: measured spend ${ledger.knownTotalUsd} USD passed caps.maxUsd=${caps.maxUsd}${overLines.length > 0 ? ` (non-zero lines: ${overLines.join(", ")})` : ""}. The cap stops the run; it is not a warning.`,
    };
  }
  if (caps.maxJobs !== undefined) {
    let knownJobs = 0;
    for (const category of COST_CATEGORIES) {
      const count = ledger.lines[category].count;
      if (typeof count === "number") knownJobs += count;
    }
    if (knownJobs > caps.maxJobs) {
      return {
        ok: false,
        message: `Stopped: ${knownJobs} measured billable jobs passed caps.maxJobs=${caps.maxJobs}.`,
      };
    }
  }
  return { ok: true };
}
