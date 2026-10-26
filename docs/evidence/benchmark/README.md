# Taskly efficacy benchmark

`pnpm bench` sends synthetic participants through the two Taskly builds in `bench/`, then scores
what they reported against a committed answer key. The planted build has the five defects in
[bench/DEFECTS.md](../../../bench/DEFECTS.md); the clean build differs only in `app.js`. The
runner scores each participant's closing report and each run's analysis findings. No model grades
anything: the rubric is a set of patterns over the report text plus facts read from the run's
trace, and every score names the sentence it came from.

## Run it

From a checkout, with `OPENAI_API_KEY` and `E2B_API_KEY` in a dotenv file:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm bench --dry-run
pnpm bench --dotenv path/to/.env --out docs/evidence/benchmark
```

The dry run builds the throwaway project, has the CLI dry-run every generated study, and prints the
cost projection. It needs no keys and spends nothing. The live command writes
`<date>-<version>-<mission>-<brains>.json` and a Markdown summary of the same name to `--out`.

| Flag                       | Default               | Meaning                                                                       |
| -------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `--brain <ids>`            | `openai-computer-use` | Comma-separated: `openai-computer-use`, `local-agent-claude`, `local-agent-codex` |
| `--runs <n>`               | 3                     | Runs per arm per brain. Each run has one participant and one analysis         |
| `--max-usd <usd>`          | 7                     | Cap on estimated spend per brain                                              |
| `--mission <id>`           | `neutral`             | `neutral` or `walked` (below)                                                 |
| `--dry-run`                | off                   | Plan and estimate only                                                        |
| `--dotenv <path>`          | none                  | Passed to `humanish run` and `humanish reclaim`; loaded by Node for `analyze`  |
| `--cli <path>`             | `dist/cli.js`         | Another humanish build, such as an installed package's `dist/cli.js`          |
| `--participant-cap <usd>`  | 0.6                   | The generated study's `caps.maxUsd` for a priced participant                  |
| `--participant <model[@effort]>` | the CLI's default | The `openai-computer-use` participant's `actor.model` and `actor.reasoningEffort` |
| `--service-tier fast`      | none                  | The participant's `actor.serviceTier`: OpenAI Fast mode on every request      |
| `--persona <file>`         | `humanish/personas/synthetic-new-user.yaml` | The persona file the generated studies copy and name                |
| `--storage <where>`        | `memory`              | `memory`: tasks are lost on a page reload. `local`: both builds keep tasks in localStorage (below) |
| `--analysis-max-usd <usd>` | the admitted cost     | Override the automatic per-run cap with a fixed `humanish analyze --max-cost` |
| `--analysis-max-output-tokens <n>` | 16384 | Each analysis's output limit, 256 to 32768, passed to `humanish analyze --max-output-tokens` |
| `--no-analysis`            | off                   | Score participant reports only                                                |
| `--work-dir <dir>`         | a new temp directory  | The project, its `.humanish/runs`, `manifest.json` and `cli.log`              |
| `--out <dir>`              | the work directory    | Where the results file and summary go                                         |
| `--rescore <work-dir>`     | none                  | Score an earlier invocation's bundles again with the current rubric; no spend |
| `--analysis-models <list>` | none                  | Analyze every recorded run once per model, after all participants ran (below) |
| `--analysis-repeats <n>`   | 1                     | Analyses of each run per model                                                |
| `--analysis-concurrency <n>` | 4                   | Analyses in flight at once, across every model                                |
| `--reanalyze <work-dir>`   | none                  | Run only the analysis models on an earlier invocation's recordings            |

The runner never reads a key. `humanish run` and `humanish reclaim` load `--dotenv` themselves;
`humanish analyze` has no such flag, so Node's `--env-file` loads the same file for that child.
Every child process gets `DO_NOT_TRACK=1`.

## What one invocation does

1. Writes a project into the work directory: the planted build as `build-a`, the clean build as
   `build-b`, the repo's `synthetic-new-user` persona, and one study per brain and arm named
   `bench-taskly-a-<brain>` or `bench-taskly-b-<brain>`. The participant's desktop and the analyst
   never receive a file name or id that says which arm they are in. `manifest.json`, outside the
   uploaded project, keeps the mapping.
2. Runs `humanish run --dry-run` on every study. A refused study stops the benchmark before any
   spend. The dry run's `worstCaseSandboxMinutes` sets the desktop part of the budget bound.
3. Runs planted and clean alternately (planted 1, clean 1, planted 2, ...), one participant per
   run, at least 40 seconds apart. Generated studies set `review.analysis: false`, so no automatic
   analysis starts.
4. After each run: `humanish reclaim --check`, which asks E2B whether each of the run's sandboxes
   still exists and kills nothing, then `humanish reclaim` when the check's `state` is anything
   other than `clean` (`running`, `unconfirmed` or `unknown`). Results record both states. A run
   made by humanish 0.110.0 or earlier records no owner tags, so its check reports `unknown` even
   when every receipted sandbox is gone. Then `humanish analyze --dry-run`, which reports the
   analysis's expected cost, admitted cost and worst case. By default, the per-run cap is the
   admitted cost, the smallest cap `analyze` accepts. `--analysis-max-usd` sets a fixed cap
   instead. Analysis starts only when its worst case fits the budget.
5. With `--analysis-models` or `--analysis-repeats`, step 4 skips the analysis, and once every
   participant has run, each run is analyzed by every model (see "Compare analysis models").
6. Scores every recorded run and writes the results file and summary.

With `--storage local`, each build serves the `app.js` of `bench/taskly-planted-local` or
`bench/taskly-clean-local` with the same `index.html`. Those files add a load from and a save to
localStorage and change nothing else, so a page reload keeps the list and the five planted defects
behave as on the in-memory builds. Each run gets a fresh desktop, so every run opens on an empty
list. The manifest and results record the storage, the results' fixture id is `taskly-local`, and
the results file name ends in `-local-storage`.

## Compare analysis models

Participant sessions vary more from run to run than analysis models differ, so a model comparison
holds the recordings fixed and varies only the analyst. `--analysis-models` takes a comma-separated
list; each entry is a model id, or `provider:model` to pass `--provider` as well. An `@effort`
suffix passes `--reasoning-effort`, and the entry keeps it as its label, so `gpt-6-luna` and
`gpt-6-luna@medium` are separate columns:

```bash
pnpm bench --dotenv path/to/.env --no-analysis --work-dir /tmp/taskly
pnpm bench --reanalyze /tmp/taskly --analysis-models gpt-6-astra,gpt-6-luna@medium --dry-run
pnpm bench --reanalyze /tmp/taskly --dotenv path/to/.env --analysis-models gpt-6-astra,gpt-5.6-luna \
  --analysis-repeats 2 --out docs/evidence/benchmark
```

The first command records participants without analysis. `--reanalyze` reads that work
directory's `manifest.json`, analyzes each recorded run with every model `--analysis-repeats`
times, and spends nothing on participants. `--analysis-models` or `--analysis-repeats` on a fresh
invocation does the same after the last participant run, in place of each run's own analysis. With
`--analysis-repeats` or `--reanalyze` alone, the model is the CLI's default analysis model.

Each analysis is `humanish analyze --run <id> --model <model> --rerun`, with `--provider` and
`--reasoning-effort` when the entry names them. `analyze` refuses an effort the model does not
take, and the dry run below stops the benchmark on that refusal before any spend. `--rerun` makes every analysis a new version, so no analysis is satisfied by an
earlier one with the same input and configuration; a different model or effort already has a different configuration. The manifest's `analysisMatrix` records each analysis's run, model, repeat number,
CLI version, analysis id, state, estimated spend and wall time, and scoring reads that exact
analysis id. A second `--reanalyze` of the same work directory appends to the matrix and numbers
repeats after the ones already recorded.

Up to `--analysis-concurrency` analyses run at once, and never two of one run: `humanish analyze`
locks the run it analyzes and refuses a second analysis of it with `ANALYSIS_BUSY`. Within each
repeat, a model's analyses start one run after another, model by model, so analyses in flight are
on different runs; one whose run is still busy waits for it. More analyses in flight than recorded
runs gains nothing. Repeat numbers are fixed before any analysis starts, and the manifest lists
analyses by repeat, then run in manifest order, then model in `--analysis-models` order, whatever
order they finish in. The benchmark writes the
manifest after each analysis is recorded, to a temporary file it then renames over
`manifest.json`. The first Ctrl-C stops new analyses. Each analysis runs in its own process group,
so the ones in flight finish and are recorded.

Before any spend, the benchmark asks the CLI to dry-run each model against a run id that does
not exist. `analyze` checks the analyst before it looks for the run, so a model or provider that
build does not support stops the benchmark with the CLI's reason.

The summary adds an analysis models table per brain: one column per model, with recall per
defect, total recall with its 95% interval, false assurance, invented claims on each arm,
harness-caused and unresolved findings, the analyses not scored and why, estimated spend and the
wall time of the `humanish analyze` calls, in total and per analysis. The wall time total adds
up the calls, so with concurrency it is longer than the elapsed time. A table of every analysis and
a list of each model's invented and unresolved findings follow it. Results files of an invocation
with the matrix end in `-analysis-models`.

## What it spends

Each step starts only when the spend so far plus that step's worst case fits under `--max-usd`:

- A participant run's worst case is `--participant-cap` plus the CLI's worst-case desktop minutes
  at $0.00888 a minute (8 CPU, 8 GiB). The participant cap is checked between turns, so one turn
  can pass it.
- An analysis's worst case is the `worstCaseCostUsd` `humanish analyze --dry-run` reports for that
  run: the cost if the analyst writes its whole output allowance. `analyze` refuses before sending
  anything when the expected cost plus 10%, or the worst case when that is lower, is over the cap.
  The dry run reports that figure as `admittedCostUsd`, and the automatic cap is that figure. The
  cap does not bound the bill, so the budget counts the worst case. A missing estimate refuses the
  analysis. `--analysis-max-usd` keeps a fixed per-run cap. A dispatched analysis that reports no
  usage is charged its worst case.
- Each analysis model has its own `--max-usd` cap, under the same rule as a brain's analyses: an
  analysis starts only when that model's spend in this invocation plus the worst case
  `analyze --dry-run` reports for that run and model fits under the cap. A skipped analysis is
  recorded as `skipped_budget` and later, cheaper ones can still start. Participants keep the
  per-brain cap. When analyses run at once, each one reserves its worst case against its model's
  cap before it starts and settles to its charge when it ends, so the analyses in flight can never
  together pass the cap. An analysis that fits only once one in flight settles waits for it, and
  each model's analyses are admitted in the fixed order above, so a budget stop leaves the arms
  within one run of each other in each repeat, as it does one analysis at a time.
- A `local-agent` participant's model spend has no price. It is recorded as unknown, and the cap
  bounds only its desktop and analysis spend.

On 2026-10-04, four neutral-mission runs cost $3.49 in estimates: participants $0.14 to $0.28,
desktops about $0.01 each, analyses $0.50 to $0.84. On copies of the six 0.114.0 runs,
`analyze --dry-run` with a 16,384-token output allowance reported expected costs of $1.04 to
$1.18, admitted costs of $1.14 to $1.30 and worst cases of $1.21 to $1.35; those analyses billed
$0.59 to $0.88. An `--analysis-max-usd` below a run's admitted cost refuses that run's analysis.

Those figures are for `gpt-6-astra` at high effort, the default analyst through 0.142.0. The
default analyst is now `gpt-6.1-sol` at medium effort, which on the 2026-10-21 recordings billed
about $0.06 an analysis ([2026-10-22-analysis-models.md](2026-10-22-analysis-models.md)). The dry
run counts it at that typical cost and a $0.252 worst case, so the default plan, 3 runs per arm
with analysis, is about $1.98, and $3 is the smallest cap in $0.50 steps that fits all 12 steps.
When a plan does not fit, the dry run names that smallest cap.

The dry run projects each analysis model separately. On a fresh invocation it prices the
default analyst from its recorded typical cost, and scales the typical gpt-6-astra analysis above,
$0.70 billed and $1.26 worst case, by what the same tokens cost at any other model's rates in
`src/run/pricing.ts`: 40,060 input and 7,613 output tokens billed (the mean of the
2026-10-04 analyses in `tests/fixtures/bench/taskly/analyses`), and 35,531 input tokens with the
16,384-token allowance for the worst case. A model with no rate in this checkout gets no
projection. With `--reanalyze`, the dry run asks `analyze --dry-run` about every recorded run and
model and projects from the expected cost and worst case it reports, which runs above the billed
cost for gpt-6-astra.

The benchmark's automatic cap uses a fixed 16,384-token output allowance for both the admission
check and the analysis, preserving the allowance of earlier benchmarks as the input prompt grows.
For example, the 0.114.0 run with a $1.182375 expected cost has a $1.300613 admitted cost, which
becomes its cap, and a $1.351575 worst case, which the budget counts. An explicit
`--analysis-max-usd` keeps the CLI's admission-based output sizing: `analyze` uses a
32,768-token allowance when the cap admits it, which raises the worst case. At `--max-cost 1.31`
the same run's worst case is $2.17. Automatic analysis after a user's run uses a $10 limit. Results record the analysis model, prompt version and limits;
each run's manifest records the cap it used.

## Missions

| Id        | Text                                                                                                                                                   | Use                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `neutral` | Names the app and asks for ordinary use with a few errands until the participant decides whether to keep using it. It names no feature a defect sits on | The benchmark default                     |
| `walked`  | The mission of `humanish/studies/detect-taskly-planted.yaml`: add a long task, try the filters, rename one, tidy up                                    | Comparison with the September 2026 results |

The walked mission puts one step on each planted defect. Its recall measures whether a participant
notices a broken behavior on a step it was told to take. The neutral mission also measures
whether the participant reaches the feature. Every result records the mission id, its text and
its SHA-256. Both texts are in `bench/taskly/missions.ts`, and a test holds the walked text equal to
the committed study.

## What each score means

Units: a participant report is one unit, and an analysis is one unit. Recall denominators count
planted-arm units only. Refused analyses are excluded from analysis recall. The terminal results
and generated Markdown summary list each refusal separately; a cost refusal reads "refused by
cost cap" with its admission estimate, applied cap and exclusion from recall. The results JSON
keeps those details on the run's `analysisRefusal` field. When rescoring older manifests, the
benchmark uses their recorded `budget.analysisMaxUsd` if no per-run cap was recorded.

| Score                     | Definition                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recall per defect         | Reports: the closing report has a sentence that carries the defect's claim. Analyses: some finding carries it. The summary adds a Wilson 95% interval for the total                                                                                           |
| D2 mechanism              | For each D2 hit: `data_loss` when the text says the stored task lost characters (for example "Edit confirmed only the first 30 characters were kept"), `display` when it says the label was clipped or did not wrap, `ambiguous` when it raises both, `unspecified` otherwise |
| False assurance           | Planted arm: the report says a broken control worked ("Clear completed removed the finished task") and never reports that defect. A matched assurance phrase that contains a negation does not count                                                         |
| Invented                  | A claim the answer key marks false on the build that was served: a planted defect reported on the clean build, a working control reported broken (Delete, Add, the checkbox, Edit), or Enter-does-not-save reported on the planted build                       |
| Other true claims         | A true claim outside the five defects, checked against the source: no confirmation on Delete, Clear completed always enabled, the global `left` count, and the others in the answer key                                                                       |
| Harness-caused            | A claim the trace ties to the harness: slowness with a provider stall notice, input that did not register with a failed desktop action, the browser or desktop around the app, terminal output in a web study from the persona's `clear_terminal_output` trait, or the mission's "tidy up" wording |
| Unresolved, for a person  | A paragraph with problem language that matches no claim class. It is listed in the summary and never counted as invented                                                                                                                                      |
| Used the defect's control | Reports only: the report or narration mentions the control (D1, D3, D5), the participant typed more than 30 characters in one action (D2), or always (D4, the app opens on the empty list)                                                                   |

A truncation report on the clean build is supported when the participant typed more than 120
characters in one action, because the add box has `maxlength="120"`, and invented otherwise. The
analysis of a run uses the evidence of all its participants for the same check.

## The rubric

`bench/taskly/answer-key.ts` holds every claim class: the five planted defects with their claim
and assurance patterns, ten baseline behaviors, four contradicted claims and five harness
claims, each with its truth on each build and the source line that settles it. `bench/lib/score.ts`
applies it. Results carry the rubric id, version and the SHA-256 of the answer-key file; a pattern
change is a new version, and `--rescore` reapplies the current rubric to old bundles.

The arm label reaches the scorer only to look up whether a matched claim is true on that build.
The matching never reads it. The build's storage, from the manifest, settles one claim: B10, tasks
lost on a page reload, is true on the in-memory builds and invented on the localStorage builds.
Rubric version 3 added that rule and scores the in-memory builds as version 2 did.

Rubric version 4 uses the storage a second time. On the localStorage builds a reload keeps every
saved change, so a sentence about an edit the reload took back ("Laundry edit did not persist after
Save and refresh", "after reloading, the added words were gone") is D5 there and not B10. On the
in-memory builds the same sentence stays B10. A reload that only reset the selected filter is no
longer a B10 claim. D5 also matches Save that left the row "in an editing box" or "the edit box
stayed open", and D2 matches a cut-off errand or reminder and a day name cut short in a sentence
about where the text ends ("ended at Thursd"). The version 4 cases in `tests/bench/score.test.ts`
quote 2026-10-24 and 2026-10-25 reports and analyses, each with a near miss that must not match.

Before 2026-10-26 the bench read participant items from run.json only. From run bundle v2 those
items live in the trace file (`actor.json`), so on every saved v2 to v4 run the D2 engagement flag,
narration-based engagement and the provider-stall and failed-action facts read an empty list.
`--rescore` now joins the trace file.

`tests/bench/score.test.ts` checks the rubric against 32 recorded participant reports and 6
analyses, with labels in `tests/fixtures/bench/taskly/labels.json`:

- The 24 September reports (four benchmark runs, both brains, 12 per arm) carry the labels of
  their dated results files: for each of the five defects, reported or not (120 labels; 57 of 60
  reported on the planted arm, none on the clean arm), and the two false assurances. The scorer
  matches all of them.
- The 4 reports and 2 analyses from 2026-10-04 carry the labels of that day's hand-scored review.
  The scorer maps every finding to the same defect and leaves the participant's accidental delete
  unresolved.
- The 4 reports and 4 analyses of the first `pnpm bench` run, also on 2026-10-04, carry the rubric
  author's labels. Three pattern groups were added after reading them: an analysis title saying
  Enter left an edit open, lost-on-reload phrasings, and an analysis that cannot tell clipping
  from changed text. These runs check for regressions and do not validate the rubric.
- The D2 mechanism labels are the rubric author's own reading, so they check that the rubric does
  not drift, and no second rater has scored them.
- Synthetic cases cover what no recorded run said: planted claims on the clean build, broken
  working controls, harness claims with and without trace evidence, and negated problem language.

The patterns follow this app's vocabulary. A participant who describes a defect in words the
rubric has not seen scores a miss, and the paragraph shows up as unresolved when it carries
problem language. Read the unresolved list before trusting a recall drop.

## Before each minor release

[Publish a release](../../release/publish.md) runs `pnpm bench` with its defaults (3 runs per arm,
$7) on the release commit for `openai-computer-use` and commits the summary and results file here. Compare report
recall, analysis recall and the clean arm's invented count with the previous file of the same
mission, and read every unresolved and invented line before tagging.

## Results

| Date       | humanish                     | Mission   | Brain                 | Runs per arm | Report recall | Analysis recall | Invented, clean arm | Estimated spend | Summary                                                                 |
| ---------- | ---------------------------- | --------- | --------------------- | ------------ | ------------- | --------------- | ------------------- | --------------- | ----------------------------------------------------------------------- |
| 2026-10-04 | 0.110.0, src/ as of 8be10e9b | `neutral` | `openai-computer-use` | 2            | 8/10          | 8/10            | 0 and 0             | $3.49           | [summary](2026-10-04-0.110.0-neutral-openai-computer-use.md) |
| 2026-10-05 | 0.111.0, src/ as of 0c4a6d70 | `neutral` | `openai-computer-use` | 3            | 10/15         | 8/15            | 0 and 0             | $5.10           | [summary](2026-10-05-0.111.0-neutral-openai-computer-use.md) |
| 2026-10-07 | 0.112.0, src/ as of 4a132ed6 | `neutral` | `openai-computer-use` | 3            | 11/15         | 9/15            | 0 and 0             | $5.99           | [summary](2026-10-07-0.112.0-neutral-openai-computer-use.md) |
| 2026-10-07 | 0.113.0, src/ as of 323e65a0 | `neutral` | `openai-computer-use` | 3            | 10/15         | 6/10            | 0 and 0             | $5.83           | [summary](2026-10-07-0.113.0-neutral-openai-computer-use.md) |
| 2026-10-08 | 0.114.0, src/ as of dabf6569 | `neutral` | `openai-computer-use` | 3            | 11/15         | 9/15            | 0 and 0             | $6.19           | [summary](2026-10-08-0.114.0-neutral-openai-computer-use.md) |
| 2026-10-08 | 0.115.0, src/ as of 0b3df523 | `neutral` | `openai-computer-use` | 3            | 10/15         | 8/15            | 0 and 0             | $6.20           | [summary](2026-10-08-0.115.0-neutral-openai-computer-use.md) |
| 2026-10-09 | 0.116.0, src/ as of a3189937 | `neutral` | `openai-computer-use` | 3            | 9/15          | 8/15            | 0 and 0             | $6.14           | [summary](2026-10-09-0.116.0-neutral-openai-computer-use.md) |
| 2026-10-09 | 0.117.0, src/ as of 882d47f6 | `neutral` | `openai-computer-use` | 3            | 8/15          | 7/15            | 0 and 0             | $6.04           | [summary](2026-10-09-0.117.0-neutral-openai-computer-use.md) |
| 2026-10-09 | 0.118.0, src/ as of d183d1ae | `neutral` | `openai-computer-use` | 3            | 6/15          | 6/15            | 0 and 0             | $5.38           | [summary](2026-10-09-0.118.0-neutral-openai-computer-use.md) |
| 2026-10-09 | 0.119.0, src/ as of 6405a7c0 | `neutral` | `openai-computer-use` | 3            | 10/15         | 10/15           | 0 and 0             | $6.12           | [summary](2026-10-09-0.119.0-neutral-openai-computer-use.md) |
| 2026-10-09 | 0.120.0, src/ as of cf75cc6f | `neutral` | `openai-computer-use` | 3            | 12/15         | 11/15           | 0 and 0             | $5.87           | [summary](2026-10-09-0.120.0-neutral-openai-computer-use.md) |
| 2026-10-14 | 0.133.0, src/ as of 7147b595 | `neutral` | `openai-computer-use` | 3            | 9/15          | 8/15            | 0 and 0             | $5.87           | [summary](2026-10-14-0.133.0-neutral-openai-computer-use.md) |

Analysis models on fixed recordings, 2026-10-22: twelve analyst settings on the same 8 Taskly
recordings, and seven on three movie-game runs, in
[2026-10-22-analysis-models.md](2026-10-22-analysis-models.md). It is the basis for the
`gpt-6.1-sol` medium-effort default analyst.
[2026-10-22-luna-verbosity.md](2026-10-22-luna-verbosity.md) reruns `gpt-6-luna` with
`text.verbosity: "low"` on the same recordings and rescores every analysis with rubric version 2.
[2026-10-22-statement-rule.md](2026-10-22-statement-rule.md) reruns `gpt-6-luna` at high effort and
`gpt-6.1-sol` at medium effort after a participant statement may also cite captures or actions.
[2026-10-23-wait-time.md](2026-10-23-wait-time.md) times a one-participant study phase by phase,
three times remote and three times local, and times `gpt-6.1-sol` at medium effort, at medium
effort with low text verbosity, and at low effort on the same Taskly and movie-game recordings.
[2026-10-24-participant-models.md](2026-10-24-participant-models.md) compares five participant
settings over 40 runs each: `gpt-5.6-sol` at medium effort with and without Fast mode,
`gpt-6.1-sol` at low and medium effort, and `gpt-6-luna` at medium effort, with latency, recall,
false assurance, persona fidelity and cost per participant.
[2026-10-25-participant-default.md](2026-10-25-participant-default.md) reruns `gpt-5.6-sol` and
`gpt-6.1-sol` at medium effort, 30 runs each, on the localStorage builds (`--storage local`), and is
the basis for the `gpt-6.1-sol` participant default.
[2026-10-26-haiku-participants.md](2026-10-26-haiku-participants.md) compares `claude-haiku-5-5` at
medium and high effort with `gpt-6.1-sol` at medium effort, 30 runs per arm on each of the
in-memory and localStorage builds, with thinking tokens, the Claude-only actions, a mid-batch
screenshot count and persona fidelity.

The first run's misses: one planted participant never typed more than 28 characters, so it never
met D2; the other reported "Clear completed removed the two finished tasks" on the build where
that button does nothing, the benchmark's one false assurance, and its analysis did not list D1.
All four participants and all four analyses reported that a page reload empties the list, which
both builds do; none of the 28 walked-mission reports in the test fixtures mentions it. Three of four reports mentioned a terminal,
from the persona's `clear_terminal_output` trait.

The 0.111.0 run's misses: two of three planted participants never typed more than 30 characters,
so they never met D2, and the third did not report it. The rubric matched no analysis line for D5,
but two planted analyses name the Save defect in lines left unresolved for a person ("The plumber
edit was not retained after repeated Save attempts", "Save left editing open; Enter finished the
edit"), and one names D1 the same way; the analysis recall counts none of them. Read by hand
before tagging, those three lines are D5, D5 and D1, which puts analysis recall at 11/15. The two
clean-arm analyses that say the list was empty after a refresh are true: both builds hold tasks in
memory. One planted report says Enter did not save an edit either, which the rubric counts as
invented (B1); the same report's Save claim is D5.

The 0.112.0 run's misses: no planted report or analysis named D2. One planted participant typed
more than 30 characters in one action and did not report the truncation; the other two never did.
The first planted analysis missed D1 and names D5 only in a line the rubric left unresolved for a
person ("Repeated Save attempts did not retain the added task detail"), which puts analysis recall
at 10/15 read by hand. The second planted analysis missed D4. The clean-arm analysis line "Enter left the rename in edit mode" is
true: the clean build's edit box has no Enter handler. Four reports say the participant used no
terminal, from the persona's `clear_terminal_output` trait. The analysis prompt is now
`study-evidence-7`; the rubric scores each finding's title, summary and observations as before, and
reads neither the new headline and experience nor the design findings.

The 0.113.0 run used the same persona file, which this release rewrote to lead with a background
and dropped its `patience` and `technical_confidence` traits, so its participants got a different
prompt from 0.112.0's. Each participant also gave impressions after it ended the session, which
the analysis reads as evidence; the report rubric reads only the participant's own report. The
OpenAI organization of this run refuses server-side conversation state, so humanish carried each
conversation itself; input grew every turn for all six participants. The second planted run's
analysis was refused before any request: its admission estimate, $1.81, passed the benchmark's
$1.75 per-analysis cap. Its participant took 16 turns, the most of the six. Run by hand afterwards
with `--max-cost 2.5` ($0.87), outside the results file, that analysis lists D1, D3, D4 and D5.
No planted participant typed more than 30 characters in one action, so none met D2. The first
planted report's "clicking save while editing did not seem to respond. pressing enter saved the
change." and the third planted analysis's "Save did not retain an edit; Enter provided an
in-session workaround" are D5, which the rubric left unresolved. Read by hand, report recall is
11/15 and analysis recall 11/15 with the hand-run analysis. The planted-arm invented line "the
edit save button did nothing." (X4) is also D5. The third clean participant said it did not reach
the goal: a refresh emptied the list, which both builds do, and it would not keep using Taskly. The
clean-arm analysis lines "Enter did not finish editing; clicking Save recovered" and "Enter did not
exit editing; clicking Save applied the change" are true.

The 0.114.0 run sized each analysis's cap from that run's admission estimate plus 10%: estimates
$1.04 to $1.18 with the benchmark's 16,384-token output allowance, caps $1.14 to $1.30, bills $0.59
to $0.88. No analysis was refused, so analysis recall counts all 15 planted chances. The OpenAI
organization of this run accepts server-side conversation state, so every participant ran
threaded; input grew every turn for all six. No planted participant typed more than 30 characters
in one action, so none met D2. The first planted participant edited a task, said editing worked,
and made no claim about Save, so its report misses D5. Two planted analysis lines the rubric left
unresolved are planted defects: "Completed tasks remained after the clear attempt" in the second
run is D1, and "Edited wording reverted despite repeated Save attempts" in the third is D5. Read by
hand, analysis recall is 11/15. The clean-arm analysis line "Enter-to-save expectation was not met
during editing" is true: the clean build's edit box has no Enter handler. "Five-task list absent
from the first post-refresh view" is true on both builds. All six reports say the participant saw
no terminal output, from the persona's `clear_terminal_output` trait.

The 0.115.0 run took each analysis's cap from the dry run's `admittedCostUsd`, the expected cost
plus 10%: expected $1.03 to $1.21, caps $1.14 to $1.33, bills $0.59 to $1.01. The budget gate
counted each analysis at its worst case, and every planned run and analysis still fit under $7, so
no analysis was refused or skipped and analysis recall counts all 15 planted chances. Every
participant ran threaded and ended on its own; each was sent the impressions request and gave 5 or
6 impressions, all within the closing report's limits. Input grew every turn except in the first
planted run, whose first reply hit its 1,024-token limit and was asked again with the same input.
No planted participant typed more than 30 characters in one action, so none met D2. Two planted
analysis lines the rubric left unresolved are D5: "Save left editing open; Enter finished the
edit" in the first run and "New wording did not survive the rename attempts" in the third. Read
by hand, analysis recall is 10/15. The clean-arm analysis line "Reported edit-focus uncertainty
resolved by clicking the field" is true: the clean build's edit box is not focused when it opens.
Five of six reports say the participant saw no terminal output, from the persona's
`clear_terminal_output` trait.

The 0.116.0 run took each analysis's cap from the dry run's `admittedCostUsd`: expected $1.01 to
$1.12, caps $1.11 to $1.23, bills $0.61 to $0.85. No analysis was refused or skipped. Every
participant ran threaded, input grew every turn, and each ended on its own and gave 6 impressions.
The participants pressed Enter, Ctrl+A, Ctrl+R and End, keys `@e2b/desktop`'s own table already
mapped, as the 0.115.0 participants did, so the hosted key translation in this release changed no
keypress here. No planted participant typed more than 30 characters in one action, so none met D2.
Two lines the rubric left unresolved are D5: the first planted report's "clicking save while
editing did not seem to finish the edit; pressing enter did." and the third planted analysis's
"Save attempts did not retain the edited wording". Read by hand, report recall is 10/15 and
analysis recall 9/15. The second planted participant pressed Clear completed and reported "i used
clear completed to remove it.", a false assurance on the build where that button does nothing, and
its analysis says the participant used Clear completed. No planted analysis listed D1; 0.115.0's
listed it twice. The clean-arm analysis line "Empty list after refresh led to reported rejection of
continued use" is true on both builds. Five of six reports say the participant saw no terminal
output, from the persona's `clear_terminal_output` trait.

The 0.117.0 run took each analysis's cap from the dry run's `admittedCostUsd`: expected $1.03 to
$1.12, caps $1.14 to $1.23, bills $0.66 to $0.76. No analysis was refused or skipped. Every
participant ran threaded, and each ended on its own and gave 5 or 6 impressions. The first clean
participant's first reply reached the 1,024-token output limit and was sent again; after it, input
grew every turn. The third clean participant gave up after a reload emptied the list ("I would not
keep using a to-do list that loses the list on refresh"), so its run reads as failed; its report and
analysis were scored as the others were. Every wait the participants sent followed another action
in the same turn and lasted 500 ms, as it did on 0.116.0, so this release's longer wait for a turn
that only waits changed no wait here: 10 waits in all, against 14 on 0.116.0. No planted participant
typed more than 30 characters in one action, so none met D2. The planted analysis line "Repeated
clearing attempts left completed tasks visible", which the rubric left unresolved, is D1: read by
hand, analysis recall is 8/15, and report recall stays 8/15. The clean-arm report line "pressing
enter while editing did not save the change; i had to click save." is true: the clean build's edit
box has no Enter handler. Five of six reports say the participant saw no terminal output, from the
persona's `clear_terminal_output` trait.

The 0.118.0 run took the analysis cap from the dry run's `admittedCostUsd`, $1.13: expected $0.99 to
$1.07, bills $0.53 to $0.75. No analysis was refused or skipped. Every participant ran threaded,
ended on its own and gave 5 or 6 impressions. Against 0.117.0, D1 and D5 account for the drop. Only
one planted participant pressed Clear completed (3 of 3 on 0.117.0), on the empty list's
`undefined` row, then added a task in the same turn, which replaced that row; its report says "Clear
completed removed it", which the rubric counts as a false assurance for D1. All three planted
participants used Save in edit mode and none reported it doing nothing, where one report and one
analysis did on 0.117.0. D3 and D4 stayed 3/3 for reports and analyses. The two unresolved analysis
lines are on the clean arm, "Reported edit-focus hesitation, followed by a successful save" and
"Empty list after refresh undermined reported trust"; both describe what the clean build does, so
read by hand recall stays 6/15 for reports and 6/15 for analyses. No planted participant typed more
than 30 characters in one action, so none met D2. All six reports say the participant saw no
terminal output, from the persona's `clear_terminal_output` trait.

The 0.119.0 run took the analysis cap from the dry run's `admittedCostUsd`, $1.25; bills were $0.60
to $0.86. No analysis was refused or skipped. Every participant ran threaded, ended on its own with
`goal_satisfied` and gave 5 or 6 impressions. Against 0.118.0, D1 and D5 account for the rise: two
planted reports and two planted analyses name each, where none did on 0.118.0. D3 and D4 stayed 3/3
for reports and analyses. Two unresolved lines name D5 on the planted arm. Planted 1's report says
"editing exposed a save button, but clicking it did nothing. pressing enter eventually saved the
change." Planted 3's analysis finding "Edited wording did not survive a filter change after Save"
says repeated Save attempts did not produce a stable edited result. Read by hand, recall is 11/15
for reports and 11/15 for analyses. Planted 1's other unresolved analysis line, "Unintended task
removal during a filter-to-clear sequence", describes a click at a button's old position after the
footer moved; it is not a planted defect. On the clean arm, one unresolved line reports a
participant's hesitation before clearing completed tasks, and the others describe what the clean
build does: no Enter handler in edit mode, and an empty list after a refresh. No planted participant
typed more than 27 characters in one action, so none met D2. Four of six reports say the participant
saw no terminal output, from the persona's `clear_terminal_output` trait. A separate investigation
read the decline from 0.114.0 to 0.118.0 as noise at three runs per arm: a same-hour A/B of npm
0.114.0 and main at d183d1ae scored 52/80 planted-report recall on each over 16 planted
participants. Three runs per arm cannot separate this rise from the same noise. The run used the
release commit 53dbf23e. The release branch then took the fix that redacts study warnings before the
run records them; it changes what the bundle records and nothing a participant receives or does, so
the run stands for 0.119.0.

The 0.120.0 run took the analysis cap from the dry run's `admittedCostUsd`, $1.21; bills were $0.64
to $0.93. The bench skipped the clean 3 analysis as `skipped_budget`: spend stood at $5.87 after
that run, and its analysis could have passed the $7 cap. The analysis column therefore covers 3
planted and 2 clean participants. Every participant ran threaded, ended on its own with
`goal_satisfied` and gave 6 impressions. Against 0.119.0, D1 and D5 account for the rise: all three
planted reports name each, where two did on 0.119.0, and all three planted analyses name D1. Read
from the click coordinates in the traces, every planted participant committed its first edit with
the row's Save button (3 of 3, as on 0.119.0) and pressed Clear completed after checking a task (3
of 3, against 2 of 3). D3 and D4 stayed 3/3 for reports and analyses. One unresolved line is on the
planted arm: planted 2's analysis finding "Edited task text reverted after Save and filter changes"
says the revised wording stayed in the editor after Save and returned to the original after the
filters changed, which is D5. Read by hand, analysis recall is 12/15, and report recall stays 12/15.
No planted participant typed more than 28 characters in one action, so none met D2. Five of six
reports say the participant saw no terminal output, from the persona's `clear_terminal_output`
trait. Three runs per arm cannot separate this rise from the run-to-run variation described above.

The 0.133.0 run is the first since 0.120.0. Every participant ran threaded and ended on its own
with `goal_satisfied`. D3 and D4 stayed 3/3 for reports and analyses. The misses come from reach:
read from the traces, one planted participant of three pressed Clear completed after checking a
task, and that one reported D1; no planted participant met D2. All three used the row's Save
button, and two reported D5. Planted 1's unresolved analysis line "Repeated Clear completed attempts
left both completed tasks visible" is D1, so analysis recall read by hand is 9/15. On the clean arm,
two reports and two unresolved lines say Enter did not save an edit or the list was empty after a
refresh, which is what the clean build does. Six of six reports say the participant saw no terminal
output, from the persona's `clear_terminal_output` trait. Three runs per arm cannot separate this
result from the run-to-run variation described above.

## What these numbers are not

Planted defects are more legible and more reachable than most real defects, so recall here is an
upper bound for an app nobody planted. Repeated runs share a model, persona, mission and app, and
the September records show near-identical sessions, so N runs are closer to repeated draws of one
configuration than to N independent people. The `synthetic-new-user` persona still declares
`accessibility_needs: clear_terminal_output`; it stays unchanged so results compare with the
September runs, and the harness-caused count shows when it surfaces. The clean `app.js` opens with
a comment that names it the clean build, which a participant could read through view-source.
