# Study cost statistics

`humanish stats` leads with the known estimated spend across the selected runs:
participant and desktop estimates plus every distinct retained analysis attempt.
It separates those components and shows missing usage and incomplete history.
All amounts are estimates from retained rate-table accounting, not provider bills.

```bash
humanish stats
humanish stats --study sample-study --since 2026-09-01 --json
```

The filters select runs by study and run start date. All later analysis reruns
belong to their source run for filtering and daily grouping. This is study-cost
attribution, not a calendar of provider charges.

With no filters, a directory whose source metadata is unreadable can still
contribute valid analysis receipts under `(no study)` and `(undated)`. Study/date
filters exclude such unattributable directories; they remain named in
`unreadable`. The command does not guess their date or study from an analysis.

## Additive JSON contract

The envelope is `humanish.stats.v2`, which says `study` and `studies` where `humanish.stats.v1`
said `lab` and `labs`. Its fields keep their meanings: `totals.estimatedSpendUsd`,
`days[].estimatedSpendUsd`, each study's `medianCostUsd`,
`costSamples` and `unpricedRuns` describe participant/desktop run estimates.
They do not suddenly include a separate analysis request. The bundle's
`cost.estimatedTotalUsd`, `status.json`'s `outcome.estimatedCostUsd` and the run
index's `estimatedCostUsd` stay participants and desktops only.

Each study's `passed` counts the runs that show as passed on every surface
(`runDisplay` in `src/run/display.ts`): a `pass` verdict and a run whose own `ok`
is not false. `passRate` divides it by `judged`, the runs with a verdict.
`totals.verdicts` counts the participants' verdicts; `totals.outcomes` counts
every selected run by its display state (`passed`, `failed`, `blocked`,
`timed_out`, `no_verdict`, `dry_run`, `interrupted`, `running`, `unknown`), and
the human output prints that line.

## One run's cost

A run's analysis spend has one reader, `readAnalysisAccounting` in
`src/run/costs.ts`. Stats calls it for `costs.analysisEstimatedUsd`, and the
surfaces that show one run's cost read it too: the run index's `analysisCost`,
and the `spend` field of the Observer's companion `observer/study-analysis.json`.
It counts every distinct attempt the way stats does, so a run analyzed twice
shows two analyses. `src/run/run-cost.ts` adds that spend to the run's
participants-and-desktops figure, and the Observer's cost line, the Observer
library row's `costLabel` and the terminal UI all format the result through it.
The total is a lower bound, shown as `est. ~$X plus unpriced usage`, while any
part has an unpriced or incomplete figure. A Codex-account analysis has no
dollar price and reads "dollar cost unknown". An analysis that sent no request
adds nothing.

The new `costs` object appears on totals, each study and each day. `costsByRun`
contains the same accounting per selected run with stable warning codes.

| Field                           | Meaning                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `estimatedTotalUsd`             | Sum of the retained run and analysis estimates                          |
| `runEstimatedUsd`               | Participant/desktop estimate; may be a known subtotal                   |
| `analysisEstimatedUsd`          | Sum of all distinct retained analysis estimates                         |
| `incompleteRunEstimates`        | Runs with partial or unknown participant/desktop accounting             |
| `analysisAttempts`              | Distinct retained execution IDs, including unresolved claims            |
| `analysisDispatchedAttempts`    | Attempts whose final accounting confirms transport                      |
| `analysisNotDispatchedAttempts` | Attempts whose final accounting confirms no transport                   |
| `analysisUnpricedAttempts`      | Dispatched or potentially dispatched attempts without a complete price  |
| `analysisUnresolvedAttempts`    | Claims without usable final accounting; a subset of unpriced attempts   |
| `analysisHistoryUncertainRuns`  | Runs with absent, legacy report-only, unreadable or conflicting history |

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
A dry run with no recorded cost counts as a known $0, because it makes no model
request and creates no desktop. A dry run that records an unknown figure stays
unknown.

Older reports without receipts contribute their strictly validated accounting
metadata with a legacy warning. Provider requests that left no durable record
in older versions cannot be reconstructed. A missing or corrupt inventory is
explicitly uncertain. Reads are contained and bounded, and never dispatch,
repair accounting, update timestamps or write files.

The report covers retained study bundles only. It cannot account for separately
launched preflight desktops, deleted runs, third-party application hosting,
provider subscriptions, or spending outside the selected project directory.
