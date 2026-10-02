// Cost and account-billing checks for verify: every claimed dollar figure carries its provenance,
// totals match their known lines, and account-billed participants never acquire a price.

import { validActorExecutionProfile, validActorProviderRequests } from "../actors/contract.js";
import type { RunBundle } from "../run/bundle.js";
import { round6 } from "../run/pricing.js";
import type { RunStream } from "../run/streams.js";

/** Account-billed participants must never acquire a price through an aggregate or ambiguous model line. */
export function contradictsAccountBilling(
  streams: readonly {
    id?: string;
    laneId?: string;
    actor?: { executionProfile?: { billing?: unknown } | undefined };
    liveActor?: { executionProfile?: { billing?: unknown } | undefined };
  }[],
  cost: { fullyEstimated?: unknown; breakdown?: unknown } | undefined,
): boolean {
  const account = (stream: (typeof streams)[number]): boolean =>
    (stream.liveActor?.executionProfile ?? stream.actor?.executionProfile)?.billing ===
    "account-unknown";
  if (!cost || !streams.some(account)) return false;
  if (cost.fullyEstimated === true) return true;
  if (!Array.isArray(cost.breakdown)) return true;
  return cost.breakdown.some(
    (line: { kind?: unknown; estimatedCostUsd?: unknown; laneId?: unknown }) => {
      if (line?.kind !== "model-tokens" || typeof line.estimatedCostUsd !== "number") return false;
      const owners =
        typeof line.laneId === "string"
          ? streams.filter((s) => s.id === line.laneId || s.laneId === line.laneId)
          : streams;
      return owners.length !== 1 || account(owners[0]!);
    },
  );
}

/**
 * Verify the LABELING/provenance of any cost figure a bundle CLAIMS — never its magnitude. Returns
 * [] (pass) unless a dollar claim lacks its provenance (invariant 6) or a total misreports its
 * known lines. ABSENCE always passes (fail-open on display, discipline #3): a bundle with no cost,
 * a null estimate, or a participant without estimatedCost is fine. A NON-NULL figure must carry its
 * ratesAsOf date + source; a NUMBER total must equal round6(sum of ONLY the non-null lines) and a
 * null line may never be coerced to 0. A null estimate must be declared honestly (a reason + null
 * ratesAsOf), mirroring the terminal no-spend proof's null-discipline. Account-billed participants
 * also have their execution profile and provider request receipts checked here.
 */
export function costAndReceiptFindings(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (contradictsAccountBilling(bundle.streams, bundle.cost))
    findings.push("Run cost lines contradict account billing identity");
  findings.push(...costSummaryFindings(bundle.cost));
  for (const stream of bundle.streams) {
    for (const actor of [stream.actor, stream.liveActor]) {
      findings.push(...executionReceiptFindings(actor));
    }
    findings.push(...participantEstimateFindings(stream));
  }
  return findings;
}

function costSummaryFindings(cost: RunBundle["cost"]): string[] {
  const findings: string[] = [];
  if (!cost) return findings;
  if (cost.schema !== "humanish.run-cost-summary.v1") {
    findings.push(
      `run cost summary schema is ${String(cost.schema)}, expected humanish.run-cost-summary.v1`,
    );
  }
  let knownSum = 0;
  let anyKnown = false;
  for (const [index, line] of (cost.breakdown ?? []).entries()) {
    if (line.estimatedCostUsd === null) {
      continue;
    }
    anyKnown = true;
    knownSum += line.estimatedCostUsd;
    if (typeof line.ratesAsOf !== "string" || line.ratesAsOf.length === 0) {
      findings.push(
        `cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a ratesAsOf date`,
      );
    }
    if (typeof line.source !== "string" || line.source.length === 0) {
      findings.push(
        `cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a pricing source`,
      );
    }
  }
  if (cost.estimatedTotalUsd !== null) {
    // A spend-free run's explicit zero prices nothing, so only a priced line needs a rates date.
    if (anyKnown && (typeof cost.ratesAsOf !== "string" || cost.ratesAsOf.length === 0)) {
      findings.push("run cost summary claims a number estimatedTotalUsd without a ratesAsOf date");
    }
    if (round6(cost.estimatedTotalUsd) !== round6(knownSum)) {
      findings.push(
        `run cost estimatedTotalUsd ${cost.estimatedTotalUsd} does not equal the sum of its known breakdown lines (${round6(knownSum)})`,
      );
    }
  } else if (anyKnown) {
    // Every-line-null is the only honest null total; a null total beside a known line hides spend.
    findings.push(
      "run cost estimatedTotalUsd is null but a breakdown line carries a known (non-null) cost",
    );
  }
  return findings;
}

/** An account-billed participant's execution profile and provider request receipts. */
function executionReceiptFindings(actor: RunStream["actor"] | RunStream["liveActor"]): string[] {
  const findings: string[] = [];
  if (actor?.executionProfile === undefined) return findings;
  if (!validActorExecutionProfile(actor.executionProfile))
    findings.push("Invalid actor execution profile");
  if (!validActorProviderRequests(actor.providerRequests))
    findings.push("Invalid account participant request receipts");
  if (
    actor.historyTurnsOmitted !== undefined &&
    (!Number.isSafeInteger(actor.historyTurnsOmitted) || actor.historyTurnsOmitted < 0)
  )
    findings.push("Invalid participant history omission count");
  if (
    actor.executionProfile?.billing === "account-unknown" &&
    (typeof actor.estimatedCost?.estimatedCostUsd === "number" ||
      actor.tokenUsage?.costUsd !== undefined)
  )
    findings.push("Account participant dollars must remain unknown");
  return findings;
}

function participantEstimateFindings(stream: RunStream): string[] {
  const findings: string[] = [];
  const estimate = stream.actor?.estimatedCost;
  if (!estimate) return findings;
  const participantLabel = stream.laneId ?? stream.id;
  if (estimate.schema !== "humanish.actor-estimated-cost.v1") {
    findings.push(
      `participant ${participantLabel} actor estimatedCost schema is ${String(estimate.schema)}, expected humanish.actor-estimated-cost.v1`,
    );
  }
  if (estimate.estimatedCostUsd !== null) {
    if (typeof estimate.ratesAsOf !== "string" || estimate.ratesAsOf.length === 0) {
      findings.push(
        `participant ${participantLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a ratesAsOf date`,
      );
    }
    if (typeof estimate.source !== "string" || estimate.source.length === 0) {
      findings.push(
        `participant ${participantLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a pricing source`,
      );
    }
  } else {
    // Declared-absent honesty (invariant 5): a null estimate must say WHY and carry null ratesAsOf.
    if (estimate.reason === undefined) {
      findings.push(
        `participant ${participantLabel} records a null cost estimate without a reason`,
      );
    }
    if (estimate.ratesAsOf !== null) {
      findings.push(
        `participant ${participantLabel} records a null cost estimate but carries a non-null ratesAsOf`,
      );
    }
  }
  return findings;
}
