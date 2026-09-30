import type { ActorTrace } from "../actors/contract.js";
import type { DesktopResourceObservation } from "../substrates/e2b/desktop-resources.js";
import {
  estimateActorCostForExecution,
  estimateAllocatedDesktopCost,
  estimateDesktopCost,
  round6,
} from "./pricing.js";
import { type RunCostLine, type RunCostSummary } from "./bundle.js";

// The run cost summary (run.json `cost`): one line per participant's model tokens and one per
// hosted sandbox's compute time, priced from src/run/pricing.ts where a rate exists.

/** One hosted sandbox's observed lifetime and size. */
export interface DesktopUsage {
  laneId?: string;
  minutes: number | undefined;
  observation: DesktopResourceObservation | undefined;
  lifetimeComplete: boolean;
}

type CostLane = { laneId?: string; trace: ActorTrace };

interface CostArgs {
  lanes: CostLane[];
  /** Legacy library input: uses a labeled planning assumption; live routes use desktops. */
  desktopMinutes?: number | undefined;
  desktops?: DesktopUsage[];
}

export function buildRunCostSummary(args: CostArgs): RunCostSummary | undefined {
  const breakdown = [...modelCostLines(args.lanes), ...desktopCostLines(args)];
  if (breakdown.length === 0) {
    return undefined;
  }
  const totals = costTotals(breakdown);
  return {
    schema: "humanish.run-cost-summary.v1",
    currency: "usd",
    estimatedTotalUsd: totals.estimatedTotalUsd,
    ratesAsOf: totals.minRatesAsOf,
    fullyEstimated: !totals.anyNull,
    placeholder: totals.placeholder,
    breakdown,
    tokenUsage: runTokenUsage(args.lanes),
    desktopMinutes: runDesktopMinutes(args),
    note: costNote(args, totals),
  };
}

/** Each participant's model-token lines: an estimate, and a null line for each unreported part. */
function modelCostLines(lanes: CostLane[]): RunCostLine[] {
  const breakdown: RunCostLine[] = [];
  for (const lane of lanes) {
    const usage = lane.trace.tokenUsage;
    // A stalled/ambiguous interaction can remain unreported after a later successful retry.
    // Keep known token estimates and make the additional unknown explicit.
    if (lane.trace.interactionUsageIncomplete === true) {
      breakdown.push({
        kind: "model-tokens",
        ...(lane.laneId === undefined ? {} : { laneId: lane.laneId }),
        ...(lane.trace.providerVersion === undefined
          ? {}
          : { modelId: lane.trace.providerVersion }),
        estimatedCostUsd: null,
        reason: "interaction_usage_unreported",
        ratesAsOf: null,
      });
    }
    // An attempted closing request has its own accounting boundary.
    if (lane.trace.debrief?.usageReported === false) {
      breakdown.push({
        kind: "model-tokens",
        ...(lane.laneId === undefined ? {} : { laneId: lane.laneId }),
        ...(lane.trace.providerVersion === undefined
          ? {}
          : { modelId: lane.trace.providerVersion }),
        estimatedCostUsd: null,
        reason: "closing_usage_unreported",
        ratesAsOf: null,
      });
    }
    const est =
      lane.trace.executionProfile?.billing === "account-unknown"
        ? estimateActorCostForExecution(usage, lane.trace.ids.model, lane.trace.executionProfile)
        : lane.trace.estimatedCost;
    if (!est) {
      continue;
    }
    breakdown.push({
      kind: "model-tokens",
      ...(lane.laneId === undefined ? {} : { laneId: lane.laneId }),
      ...(est.modelId === undefined ? {} : { modelId: est.modelId }),
      estimatedCostUsd: est.estimatedCostUsd,
      ...(est.reason === undefined ? {} : { reason: est.reason }),
      ratesAsOf: est.ratesAsOf,
      ...(est.source === undefined ? {} : { source: est.source }),
      ...(est.placeholder ? { placeholder: true } : {}),
    });
  }

  return breakdown;
}

/** Each hosted sandbox's compute line, or the legacy planning line when only minutes are given. */
function desktopCostLines(args: Pick<CostArgs, "desktopMinutes" | "desktops">): RunCostLine[] {
  const breakdown: RunCostLine[] = [];
  for (const usage of args.desktops ?? []) {
    const observation = usage.observation;
    const resources = observation && "resources" in observation ? observation.resources : undefined;
    const estimate = estimateAllocatedDesktopCost(usage.minutes, resources);
    breakdown.push({
      kind: "desktop-minutes",
      ...(usage.laneId === undefined ? {} : { laneId: usage.laneId }),
      estimatedCostUsd: estimate.estimatedCostUsd,
      ...(estimate.reason === undefined ? {} : { reason: estimate.reason }),
      ratesAsOf: estimate.ratesAsOf,
      ...(estimate.source === undefined ? {} : { source: estimate.source }),
      desktop: {
        minutes: estimate.minutes,
        durationBasis: "host-acquired-to-cleanup",
        ...(resources === undefined ? {} : { resources, resourceSource: "e2b.getInfo" }),
        ...(observation && "reason" in observation
          ? { resourceUnavailableReason: observation.reason }
          : {}),
        ...(estimate.usdPerSecond === undefined ? {} : { usdPerSecond: estimate.usdPerSecond }),
      },
    });
    if (!usage.lifetimeComplete) {
      breakdown.push({
        kind: "desktop-minutes",
        ...(usage.laneId === undefined ? {} : { laneId: usage.laneId }),
        estimatedCostUsd: null,
        reason: "desktop_lifetime_incomplete",
        ratesAsOf: null,
      });
    }
  }

  if (args.desktops === undefined && args.desktopMinutes !== undefined) {
    const desktop = estimateDesktopCost(args.desktopMinutes);
    breakdown.push({
      kind: "desktop-minutes",
      estimatedCostUsd: desktop.estimatedCostUsd,
      ...(desktop.reason === undefined ? {} : { reason: desktop.reason }),
      ratesAsOf: desktop.ratesAsOf,
      ...(desktop.source === undefined ? {} : { source: desktop.source }),
      ...(desktop.placeholder ? { placeholder: true } : {}),
    });
  }
  return breakdown;
}

/** The priced total and its freshness; a null line makes the total a lower bound. */
function costTotals(breakdown: RunCostLine[]): {
  estimatedTotalUsd: number | null;
  anyNull: boolean;
  placeholder: boolean;
  minRatesAsOf: string | null;
} {
  let knownSum = 0;
  let anyKnown = false;
  let anyNull = false;
  let placeholder = false;
  // Aggregate freshness is CONSERVATIVE: an aggregate estimate is only as current as its OLDEST
  // contributing rate, so ratesAsOf takes the MIN (oldest) asOf — MAX would overclaim freshness the
  // moment operator-edited rates in src/run/pricing.ts diverge. Each breakdown line keeps its own true asOf.
  let minRatesAsOf: string | null = null;
  for (const line of breakdown) {
    if (line.estimatedCostUsd === null) {
      anyNull = true;
      continue;
    }
    anyKnown = true;
    knownSum += line.estimatedCostUsd;
    if (line.placeholder) placeholder = true;
    if (line.ratesAsOf !== null && (minRatesAsOf === null || line.ratesAsOf < minRatesAsOf)) {
      minRatesAsOf = line.ratesAsOf;
    }
  }
  return {
    estimatedTotalUsd: anyKnown ? round6(knownSum) : null,
    anyNull,
    placeholder,
    minRatesAsOf,
  };
}

/** The summary's note: what the total means, then what the desktop lines measured. */
function costNote(args: CostArgs, totals: ReturnType<typeof costTotals>): string {
  const { estimatedTotalUsd, anyNull, placeholder, minRatesAsOf } = totals;
  const estimateNote =
    estimatedTotalUsd === null
      ? `No priced spend lines this run — every cost line is DECLARED ABSENT (unknown rate / no usage / no duration); nothing is guessed. ${args.lanes.some((lane) => lane.trace.executionProfile?.billing === "account-unknown") ? "Account billing remains unknown; API prices do not measure account spend." : "Add a rate to src/run/pricing.ts to estimate this model."}`
      : `Estimated ${estimatedTotalUsd} USD total${anyNull ? " (LOWER BOUND — some lines unmeasured/unpriced)" : ""}${placeholder ? "; includes PLACEHOLDER rate(s) — confirm before trusting the magnitude" : ""}. Every figure is an ESTIMATE (rates as of ${minRatesAsOf} — the OLDEST contributing rate, since an aggregate is only as fresh as its stalest input), a rate-table multiply, NOT an authoritative provider charge.`;
  return (
    estimateNote +
    ((args.desktops?.length ?? 0) > 0
      ? args.desktops!.some(
          (usage) => usage.observation !== undefined && "resources" in usage.observation,
        )
        ? " Desktop compute uses observed CPU/RAM and a host-acquired-to-cleanup span where available; pre-handle startup, plan fees, credits, and negotiated pricing are excluded."
        : " Desktop compute is unmeasured: no allocation CPU/RAM observation is available."
      : "")
  );
}

/** Token totals across participants; an account-billed participant leaves unknown parts out. */
function runTokenUsage(lanes: CostLane[]): RunCostSummary["tokenUsage"] {
  const sumInput = lanes.reduce((sum, lane) => sum + (lane.trace.tokenUsage?.input ?? 0), 0);
  const sumOutput = lanes.reduce((sum, lane) => sum + (lane.trace.tokenUsage?.output ?? 0), 0);
  return lanes.some((lane) => lane.trace.executionProfile?.billing === "account-unknown")
    ? {
        ...(lanes.some((lane) => lane.trace.tokenUsage?.input !== undefined)
          ? { input: sumInput }
          : {}),
        ...(lanes.some((lane) => lane.trace.tokenUsage?.output !== undefined)
          ? { output: sumOutput }
          : {}),
        ...(lanes.every(
          (lane) =>
            lane.trace.tokenUsage?.input !== undefined &&
            lane.trace.tokenUsage?.output !== undefined &&
            lane.trace.interactionUsageIncomplete !== true &&
            lane.trace.debrief?.usageReported !== false &&
            (lane.trace.executionProfile === undefined ||
              lane.trace.providerRequests?.every((r) => r.usageComplete) === true),
        )
          ? { total: sumInput + sumOutput }
          : {}),
      }
    : { input: sumInput, output: sumOutput, total: sumInput + sumOutput };
}

/** Total desktop minutes, or null when no sandbox reported a span. */
function runDesktopMinutes(args: Pick<CostArgs, "desktopMinutes" | "desktops">): number | null {
  return args.desktops === undefined
    ? (args.desktopMinutes ?? null)
    : args.desktops.some((usage) => usage.minutes !== undefined)
      ? round6(args.desktops.reduce((sum, usage) => sum + (usage.minutes ?? 0), 0))
      : null;
}

/** A live run that sent no model request and held no hosted desktop records an explicit zero, so
 *  a missing cost block always means "not measured". */
export function spendFreeCostSummary(): RunCostSummary {
  return {
    schema: "humanish.run-cost-summary.v1",
    currency: "usd",
    estimatedTotalUsd: 0,
    ratesAsOf: null,
    fullyEstimated: true,
    placeholder: false,
    breakdown: [],
    tokenUsage: { input: 0, output: 0, total: 0 },
    desktopMinutes: null,
    note: "No model request and no hosted desktop: this run spent $0 by construction.",
  };
}

// Convert a host-side desktop span (ms) into billed minutes, or undefined when no sandbox ran.
export function desktopSpanToMinutes(desktopDurationMs: number | undefined): number | undefined {
  return desktopDurationMs === undefined ? undefined : desktopDurationMs / 60_000;
}
