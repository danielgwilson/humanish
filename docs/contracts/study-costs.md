# Study cost statistics

`humanish stats` leads with the known estimated spend across the selected runs:
participant and desktop estimates plus every distinct retained analysis attempt.
It separates those components and shows missing usage and incomplete history.
All amounts are estimates from retained rate-table accounting, not provider bills.

```bash
humanish stats
humanish stats --lab sample-study --since 2026-09-01 --json
```

The filters select runs by lab and run start date. All later analysis reruns
belong to their source run for filtering and daily grouping. This is study-cost
attribution, not a calendar of provider charges.

## Additive JSON contract

The envelope remains `humanish.stats.v1`. Existing fields keep their meanings:
`totals.estimatedSpendUsd`, `days[].estimatedSpendUsd`, lab `medianCostUsd`,
`costSamples` and `unpricedRuns` describe participant/desktop run estimates.
They do not suddenly include a separate analysis request. The bundle's
`cost.estimatedTotalUsd` and the cached run-index estimate also remain unchanged.
Observer and terminal run summaries label this narrower scope.

The new `costs` object appears on totals, each lab and each day. `costsByRun`
contains the same accounting per selected run with stable warning codes.

| Field | Meaning |
| --- | --- |
| `estimatedTotalUsd` | Sum of the retained run and analysis estimates |
| `runEstimatedUsd` | Participant/desktop estimate; may be a known subtotal |
| `analysisEstimatedUsd` | Sum of all distinct retained analysis estimates |
| `incompleteRunEstimates` | Runs with partial or unknown participant/desktop accounting |
| `analysisAttempts` | Distinct retained execution IDs, including unresolved claims |
| `analysisDispatchedAttempts` | Attempts whose final accounting confirms transport |
| `analysisNotDispatchedAttempts` | Attempts whose final accounting confirms no transport |
| `analysisUnpricedAttempts` | Dispatched or potentially dispatched attempts without a complete price |
| `analysisUnresolvedAttempts` | Claims without usable final accounting; a subset of unpriced attempts |
| `analysisHistoryUncertainRuns` | Runs with absent, legacy report-only, unreadable or conflicting history |

The three amount fields are `null` when nothing in that component has an
estimate. Known zero is retained only when supported: for example, final
accounting confirms an attempt never dispatched. A known subtotal can coexist
with unknown costs; inspect the counts alongside it. An absent analysis history
is not converted into a free analysis.

## Accounting rules

Execution receipts take part regardless of whether the analysis succeeded,
its report was published, its findings are current, or the original recording
later changed. The receipt and report with the same run/analysis ID count once;
new IDs from explicit reruns count separately. Reusing a prior result adds no
attempt or expense. Conflicting accounting for the same ID stays unresolved.

Older reports without receipts contribute their strictly validated accounting
metadata with a legacy warning. Provider requests that left no durable record
in older versions cannot be reconstructed. A missing or corrupt inventory is
explicitly uncertain. Reads are contained and bounded, and never dispatch,
repair accounting, update timestamps or write files.

The report covers retained study bundles only. It cannot account for separately
launched preflight desktops, deleted runs, third-party application hosting,
provider subscriptions, or spending outside the selected project directory.
