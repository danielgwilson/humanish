// One more request when an API analyst runs out of output before it finishes its report. The same
// request is sent again, at most once, and only while the analysis's cost cap still admits it
// after counting what every request so far cost. Codex account analysis has no dollar cap to
// check, so it is never sent again.

import { estimateActorCost } from "../run/pricing.js";
import type { RequestCost } from "./admission.js";
import type { AnalysisProviderResult } from "./provider.js";
import type { AnalysisConfig, AnalysisUsage } from "./types.js";

export interface OutputRetries {
  /**
   * Whether to send request `index` again after `response`, given the attempt's usage with that
   * response counted. Adds a warning that says what ran out and what humanish did.
   */
  retry(index: number, response: AnalysisProviderResult, usage: AnalysisUsage): boolean;
  /** Request `index` has its final answer, so its cost is no longer held against the cap. */
  settle(index: number): void;
  /** The summed worst case of every request sent again, which admission did not price. */
  worstCaseUsd(): number;
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

/**
 * The retries of one attempt. `costs` are each request's costs from admission (the cohorts', then
 * the merge request's), `describe` names request `index` at the start of a sentence, and warnings
 * receive what happened.
 */
export function outputRetries(
  config: AnalysisConfig,
  costs: readonly RequestCost[],
  describe: (index: number) => string,
  warnings: string[] | undefined,
): OutputRetries {
  // What each request without a final answer may still cost: admission's figure for it.
  const held = new Map(costs.map((cost, index) => [index, cost.admittedCostUsd]));
  const retried = new Set<number>();
  let worstCase = 0;
  const warn = (text: string): void => {
    warnings?.push(text);
  };
  return {
    retry(index, response, usage) {
      if (response.errorCode !== "output_incomplete" || config.maxCostUsd === null) return false;
      const which = describe(index);
      if (retried.has(index)) {
        warn(`${which} ran out of output again, so this attempt has no report.`);
        return false;
      }
      const cap = config.maxCostUsd;
      const tokens = response.usage;
      const cost =
        tokens === null
          ? null
          : estimateActorCost({ ...tokens, turns: [tokens] }, config.model).estimatedCostUsd;
      if (
        tokens === null ||
        cost === null ||
        !usage.usageComplete ||
        usage.estimatedCostUsd === null
      ) {
        warn(
          `${which} ran out of output before it finished its report and did not report its usage, so humanish cannot tell whether a second request fits the $${cap} cap. It was not sent again.`,
        );
        return false;
      }
      const ranOut = `${which} ran out of output before it finished its report: ${tokens.output} of ${config.maxOutputTokens} output tokens, ${tokens.input} input tokens, ${usd(cost)}.`;
      const again = costs[index]!;
      let others = 0;
      for (const [other, amount] of held) if (other !== index) others += amount;
      const total = usage.estimatedCostUsd + others + again.admittedCostUsd;
      if (total > cap) {
        const running =
          others > 0 ? `, the ${usd(others)} admission holds for requests still running,` : "";
        warn(
          `${ranOut} humanish did not send it again: the ${usd(usage.estimatedCostUsd)} spent so far${running} plus ${usd(again.admittedCostUsd)} for one more request at admission's estimate is over the $${cap} cap. To retry, run the analysis again; a higher cost cap leaves room for a second request.`,
        );
        return false;
      }
      retried.add(index);
      worstCase += again.worstCaseCostUsd;
      warn(
        `${ranOut} humanish sent the same request once more; the attempt's usage counts both requests.`,
      );
      return true;
    },
    settle(index) {
      held.delete(index);
    },
    worstCaseUsd: () => worstCase,
  };
}
