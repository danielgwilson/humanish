import * as stops from "./ending.js";
import type { LostRequest, Stop } from "./ending.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaSpendGate } from "./types.js";

// The spend guards. The lane cap (maxUsd) and the study budget (overRunBudget) are priced from
// the usage each reply reports, plus a worst-case charge booked for each request lost without a
// reply. A request whose cost is unknown and unbounded stops a capped session before the next one.

/** Thrown through the provider when a lost attempt may not be sent again; carries the stop. */
export class LostRequestRefused extends Error {
  constructor(readonly stop: Stop) {
    super(stop.reason);
  }
}

/**
 * The spend caps, checked before the next provider request so a model stuck retrying cannot keep
 * spending. The lane cap stops the session once the running estimate crosses maxUsd; a null
 * estimate cannot trip it, because preflight guaranteed a rate. The study budget (#299) is checked
 * next.
 */
export function spendStop(session: LoopSession): Stop | undefined {
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  if (maxUsd !== undefined && estimateTurnCostUsd) {
    const running = estimateTurnCostUsd(session.usage.forCap());
    if (running !== null && !Number.isFinite(running)) return stops.nonFiniteEstimate;
    if (running !== null && running > maxUsd) return stops.spendLimit(session, running, maxUsd);
  }
  if (overRunBudget) {
    const runStop = overRunBudget(session.usage.forCap());
    if (runStop !== null) return stops.studySpendLimit(runStop);
  }
  return undefined;
}

/**
 * Under a declared cap, send the next request only while every earlier request's usage is known
 * or bounded by a booked worst case. A reply without usage stops the session here, after its own
 * actions ran and before any further spend. A turn that ends the session is not affected.
 */
export function unknownSpendStop(session: LoopSession): Stop | undefined {
  if (!session.capDeclared || !session.usage.unavailableForCap()) return undefined;
  session.usage.markUnreported();
  return stops.usageUnreported;
}

/**
 * Book a request lost without a reply at its worst case, and say whether it may be sent again.
 * The worst case is the latest reported request's input at the model's highest input rate plus
 * maxOutputTokens at its output rate; the reply to the resent request later replaces that input
 * with its own. Returns the stop when maxOutputTokens is unset or the charge does not fit.
 */
export function bookLostRequest(
  session: LoopSession,
  turnNumber: number,
  lost: LostRequest,
): Stop | undefined {
  const maxOutputTokens = session.provider.modelSettings?.maxOutputTokens;
  if (maxOutputTokens === undefined) {
    session.usage.markUnreported();
    return stops.lostRequestUnbounded(turnNumber, lost);
  }
  const input = session.usage.lastReportedInput();
  session.usage.reserve(input, maxOutputTokens);
  const usd = session.settings.estimateTurnCostUsd?.({
    input,
    output: maxOutputTokens,
    cachedInput: 0,
    cacheWriteInput: input,
  });
  const charge = `${input} input tokens at the highest input rate and ${maxOutputTokens} output tokens${typeof usd === "number" ? ` ($${usd})` : ""}`;
  const over = spendStop(session);
  session.trace.record("notice", () =>
    notice(
      "warn",
      "worst case booked for a lost request",
      over === undefined
        ? `provider turn ${turnNumber} ${lost}; its usage is unknown, so the spend cap counts ${charge}; sending the request again`
        : `provider turn ${turnNumber} ${lost}; its usage is unknown, so the spend cap counts ${charge}, which does not fit; the request was not sent again`,
    ),
  );
  return over;
}

/** The gate a capped session hands the provider for its own transport retries. */
export function spendGate(session: LoopSession, turnNumber: number): CuaSpendGate | undefined {
  if (!session.capDeclared) return undefined;
  return {
    beforeResend: () => {
      const refused = bookLostRequest(session, turnNumber, "failed in transit");
      if (refused !== undefined) throw new LostRequestRefused(refused);
    },
  };
}
