import { describeTokenUsage } from "./token-usage.js";
import type { ActorTokenUsage } from "../../actors/contract.js";
import type { LabScenarioCaps } from "../../lab/types.js";
import type { CostCategory, CostLine, NoSpendProof, TerminalCostLedger } from "./types.js";

/** The four cost categories, in a fixed order so the ledger shape is stable across runs. */
const COST_CATEGORIES: readonly CostCategory[] = [
  "product",
  "media",
  "payment",
  "provider",
] as const;

/**
 * Build the spend ledger from the captured session. THE NULL DISCIPLINE (issue #154):
 *   - The `provider` line is populated from the actor trace's tokenUsage.costUsd when the trace
 *     CARRIES it (a measured value, incl. a measured 0). When the trace carries NO costUsd, the
 *     provider line is `null` = NOT MEASURED (never guessed to 0 just because no-spend was intended).
 *   - product/media/payment are `null` by default: core has no signal for those categories; an
 *     adapter may provide one through the shipped costProbe seam.
 * `injectedLines` lets a test or adapter supply known spend for a category,
 * exercising the fail-closed cap enforcement deterministically without a real billable run.
 */
export function buildCostLedger(args: {
  tokenCostUsd?: number;
  /** Measured token counts, when the run produced them but no rate could price them (#531). */
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
            // reader never mistakes "no charge recorded" for "nothing was consumed" (#531).
            usd: null,
            source: "unpriced-token-usage",
            note:
              `Provider spend UNPRICED: the run consumed ${describeTokenUsage(args.tokenUsage)}, ` +
              "but the terminal lane records the model as `codex` and src/run/pricing.ts carries no " +
              "rate for it, so no dollar figure is claimed. Tokens are a MEASURED fact here; the " +
              "price is the unknown. Recorded null (never guessed to 0).",
          }
        : {
            usd: null,
            source: "unmeasured",
            note: "Provider spend NOT MEASURED: the actor trace carried no tokenUsage.costUsd this run. Recorded null (not guessed to 0).",
          };

  const unmeasured = (category: CostCategory): CostLine => ({
    usd: null,
    count: null,
    source: "unmeasured",
    note: `${category} spend NOT MEASURED: core has no ${category}-spend signal for this run; an adapter may supply one through costProbe. Recorded null (never guessed to 0).`,
  });

  const lines: Record<CostCategory, CostLine> = {
    product: args.injectedLines?.product ?? unmeasured("product"),
    media: args.injectedLines?.media ?? unmeasured("media"),
    payment: args.injectedLines?.payment ?? unmeasured("payment"),
    provider: args.injectedLines?.provider ?? providerLine,
  };

  // knownTotalUsd sums ONLY the non-null lines. A null line contributes NOTHING — it is never
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
    knownTotalUsd: roundUsd(knownTotalUsd),
    fullyMeasured,
  };
}

/** Derive the no-spend proof from the ledger. It is HONEST: it vouches for known-zero lines and
 *  explicitly lists the unmeasured (null) lines it cannot vouch for — never claiming zero on null. */
export function buildNoSpendProof(ledger: TerminalCostLedger, maxUsd: number | null): NoSpendProof {
  const knownZeroLines: CostCategory[] = [];
  const knownNonZeroLines: CostCategory[] = [];
  const unmeasuredLines: CostCategory[] = [];
  for (const category of COST_CATEGORIES) {
    const usd = ledger.lines[category].usd;
    if (usd === null) unmeasuredLines.push(category);
    else if (usd === 0) knownZeroLines.push(category);
    else knownNonZeroLines.push(category);
  }
  // satisfied only when every KNOWN line is within the cap (for a no-spend run, maxUsd 0 => every
  // known line must be exactly 0). Unmeasured lines do NOT make it satisfied — they are reported
  // separately as the proof's honest blind spot.
  const cap = maxUsd ?? 0;
  const satisfied = knownNonZeroLines.length === 0 && ledger.knownTotalUsd <= cap;
  const statement = [
    satisfied
      ? `No-spend proof SATISFIED for maxUsd=${cap}: every MEASURED spend line is zero (known total ${ledger.knownTotalUsd} USD).`
      : `No-spend proof NOT satisfied for maxUsd=${cap}: known spend total ${ledger.knownTotalUsd} USD${knownNonZeroLines.length > 0 ? ` (non-zero: ${knownNonZeroLines.join(", ")})` : ""}.`,
    // When tokens were counted but not priced, say so IN THE STATEMENT. A reader who sees
    // "SATISFIED for maxUsd=0" must not walk away thinking nothing was consumed (#531).
    ledger.lines.provider.source === "unpriced-token-usage"
      ? `Provider tokens WERE consumed on this run and are counted in the ledger; they are unpriced, not zero.`
      : "",
    unmeasuredLines.length > 0
      ? `UNPRICED (null, NOT claimed zero): ${unmeasuredLines.join(", ")}. The proof does not vouch for these. ` +
        (ledger.lines.provider.source === "unpriced-token-usage"
          ? // provider has a signal here (a token count), it just has no rate. Saying it "carries
            // no spend signal" one sentence after reporting its token total would contradict the
            // line above it.
            "Of these, provider has a measured token count but no rate; the rest carry no spend signal for this run."
          : "They carry no spend signal for this run.")
      : "All applicable spend lines were measured.",
  ]
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
 * Full caps enforcement (fail-closed, not advisory). Returns a structured violation when a KNOWN
 * (measured) spend line exceeds maxUsd, or a known billable-job count exceeds maxJobs. Unknowns
 * (`null`) NEVER trip the cap (we cannot claim a violation we did not measure) — but they also never
 * grant a green pass: the no-spend proof reports them as unmeasured. maxMinutes is wall-clock and is
 * enforced separately (runWithWallClock); it is not a ledger-derived cap.
 */
export function evaluateCapsAgainstLedger(
  ledger: TerminalCostLedger,
  caps: LabScenarioCaps,
): { ok: true } | { ok: false; message: string } {
  if (caps.maxUsd !== undefined && ledger.knownTotalUsd > caps.maxUsd) {
    const overLines = COST_CATEGORIES.filter(
      (c) => ledger.lines[c].usd !== null && (ledger.lines[c].usd as number) > 0,
    );
    return {
      ok: false,
      message: `Observed KNOWN spend ${ledger.knownTotalUsd} USD exceeds scenario.caps.maxUsd=${caps.maxUsd}${overLines.length > 0 ? ` (non-zero lines: ${overLines.join(", ")})` : ""}. The run fails closed: the cap is a fail-closed mechanism, not an advisory.`,
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
        message: `Observed KNOWN billable-job count ${knownJobs} exceeds scenario.caps.maxJobs=${caps.maxJobs}. The run fails closed.`,
      };
    }
  }
  return { ok: true };
}

/** Round a USD sum to 6 decimals so a float-accumulated total never carries spurious precision. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
