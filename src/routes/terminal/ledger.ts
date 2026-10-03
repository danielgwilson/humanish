import { describeTokenUsage } from "./token-usage.js";
import type { ActorTokenUsage } from "../../actors/contract.js";
import type { StudyScenarioCaps } from "../../study/types.js";
import { round6 } from "../../run/pricing.js";
import { COST_CATEGORIES, type CostCategory } from "../../run/terminal-contract.js";
import type { CostLine, NoSpendProof, TerminalCostLedger } from "./types.js";

/**
 * Build the spend ledger from the captured session. The null discipline:
 *   - The `provider` line is populated from the actor trace's tokenUsage.costUsd when the trace
 *     carries it (a measured value, incl. a measured 0). When the trace carries no costUsd, the
 *     provider line is `null` = not measured (never guessed to 0 just because no-spend was intended).
 *   - product/media/payment are `null` by default: core has no signal for those categories; an
 *     adapter may provide one through the shipped costProbe seam.
 * `injectedLines` lets a test or adapter supply known spend for a category,
 * exercising the fail-closed cap enforcement deterministically without a real billable run.
 */
export function buildCostLedger(args: {
  tokenCostUsd?: number;
  /** Measured token counts, when the run produced them but no rate could price them. */
  tokenUsage?: ActorTokenUsage;
  injectedLines?: Partial<Record<CostCategory, CostLine>>;
}): TerminalCostLedger {
  const providerLine: CostLine =
    typeof args.tokenCostUsd === "number"
      ? {
          usd: args.tokenCostUsd,
          source: "provider-token-usage",
          note: `Provider spend metered from the actor trace tokenUsage.costUsd (${args.tokenCostUsd} USD).`,
        }
      : args.tokenUsage
        ? {
            // Tokens counted, no rate to price them. This stays `usd: null` because a guessed
            // dollar figure would be worse than none, but the note carries the measured fact so a
            // reader never mistakes "no charge recorded" for "nothing was consumed".
            usd: null,
            source: "unpriced-token-usage",
            note:
              `Provider spend unpriced: the run consumed ${describeTokenUsage(args.tokenUsage)}, ` +
              "but the terminal participant records the model as `codex` and humanish has no rate " +
              "for it, so no dollar figure is given. The token count is measured; the price is " +
              "not known. Recorded as null, never guessed as 0.",
          }
        : {
            usd: null,
            source: "unmeasured",
            note: "Provider spend not measured: the actor trace carried no tokenUsage.costUsd in this run, so it is recorded as null and not guessed as 0.",
          };

  const unmeasured = (category: CostCategory): CostLine => ({
    usd: null,
    count: null,
    source: "unmeasured",
    note: `${category} spend not measured: humanish has no ${category} spend signal for this run, and an adapter may supply one through costProbe. Recorded as null, never guessed as 0.`,
  });

  const lines: Record<CostCategory, CostLine> = {
    product: args.injectedLines?.product ?? unmeasured("product"),
    media: args.injectedLines?.media ?? unmeasured("media"),
    payment: args.injectedLines?.payment ?? unmeasured("payment"),
    provider: args.injectedLines?.provider ?? providerLine,
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
 * What the ledger measured, in words: the dollar lines it knows, provider tokens it counted but
 * could not price, and the lines it has no signal for. A reader of a maxUsd=0 run must not take
 * an all-null ledger for a proven $0.
 */
export function describeMeasuredSpend(
  ledger: TerminalCostLedger,
  tokenUsage?: ActorTokenUsage,
): string {
  const measured = COST_CATEGORIES.filter((c) => ledger.lines[c].usd !== null).map(
    (c) => `${c} ${ledger.lines[c].usd} USD`,
  );
  const unpricedProvider = ledger.lines.provider.source === "unpriced-token-usage";
  const unmeasured = COST_CATEGORIES.filter(
    (c) => ledger.lines[c].usd === null && !(c === "provider" && unpricedProvider),
  );
  return [
    measured.length > 0 ? `Measured: ${measured.join(", ")}.` : "",
    unpricedProvider
      ? `Provider tokens were consumed${tokenUsage === undefined ? "" : ` (${describeTokenUsage(tokenUsage)})`} and are unpriced, not zero.`
      : "",
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
  caps: StudyScenarioCaps,
): { ok: true } | { ok: false; message: string } {
  if (caps.maxUsd !== undefined && ledger.knownTotalUsd > caps.maxUsd) {
    const overLines = COST_CATEGORIES.filter(
      (c) => ledger.lines[c].usd !== null && (ledger.lines[c].usd as number) > 0,
    );
    return {
      ok: false,
      message: `Stopped: measured spend ${ledger.knownTotalUsd} USD passed scenario.caps.maxUsd=${caps.maxUsd}${overLines.length > 0 ? ` (non-zero lines: ${overLines.join(", ")})` : ""}. The cap stops the run; it is not a warning.`,
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
        message: `Stopped: ${knownJobs} measured billable jobs passed scenario.caps.maxJobs=${caps.maxJobs}.`,
      };
    }
  }
  return { ok: true };
}
