import type { Stop } from "./ending.js";
import type { LoopSession } from "./session.js";
import { spendStop, unknownSpendStop } from "./spend.js";
import { notice } from "./trace.js";
import type { CuaTurn } from "./types.js";

/**
 * A reply cut off by the output-token limit carries no participant decision: its actions never
 * run. When the provider sets such a reply aside (outputLimitRetry), the loop books its usage,
 * checks the spend caps and asks once more with the same request. A second cut-off reply to the
 * same request ends the session as a provider output limit, as does a provider that cannot set
 * the reply aside.
 */
export function retryAfterOutputLimit(
  session: LoopSession,
  turn: CuaTurn,
  turnNumber: number,
  alreadyRetried: boolean,
): "retry" | Stop | undefined {
  if (turn.interruption !== "output_limit") return undefined;
  if (session.provider.outputLimitRetry !== true || alreadyRetried) return undefined;
  session.trace.bump("turns");
  session.lastResponseId = turn.responseId ?? session.lastResponseId;
  session.usage.record(turn, "interaction");
  const output = turn.usage?.output;
  session.trace.record("notice", () =>
    notice(
      "warn",
      "provider reply cut off by the output limit; asking again",
      `provider turn ${turnNumber} reached the output-token limit${output === undefined ? "" : ` after ${output} output tokens`} before any action; its actions were not run, and the same request is sent once more`,
    ),
  );
  return spendStop(session) ?? unknownSpendStop(session) ?? "retry";
}
