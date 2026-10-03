// The strict-spend composition as docs/contracts/schemas.md documents it, built only from public
// exports. scripts/public-api-proof.mjs typechecks it against the packed package; it never runs.
import {
  createOpenAiResponsesProvider,
  defaultRedactionHooks,
  runComputerUseLoop,
  type ComputerUseExecutor,
  type ComputerUseLoopResult,
} from "humanish";

declare const executor: ComputerUseExecutor;

export async function strictSession(
  apiKey: string,
  maxUsd: number,
): Promise<ComputerUseLoopResult> {
  return runComputerUseLoop({
    instructions: "Explore the app.",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    executor,
    timeoutMs: 60_000,
    provider: createOpenAiResponsesProvider({ apiKey, model: "gpt-5.5", singleDispatch: true }),
    redaction: defaultRedactionHooks,
    now: Date.now,
    maxUsd,
    estimateTurnCostUsd: () => 0,
    requireReportedUsageForSpendCap: true,
  });
}
