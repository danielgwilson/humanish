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
| `--analysis-max-usd <usd>` | admission plus 10% | Override the automatic per-run cap with a fixed `humanish analyze --max-cost` |
| `--no-analysis`            | off                   | Score participant reports only                                                |
| `--work-dir <dir>`         | a new temp directory  | The project, its `.humanish/runs`, `manifest.json` and `cli.log`              |
| `--out <dir>`              | the work directory    | Where the results file and summary go                                         |
| `--rescore <work-dir>`     | none                  | Score an earlier invocation's bundles again with the current rubric; no spend |

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
   when every receipted sandbox is gone. Then `humanish analyze --dry-run` for the admission
   estimate. By default, the per-run cap is that estimate plus 10%, limited to the remaining
   per-brain budget. `--analysis-max-usd` sets a fixed cap instead. Analysis starts only when its
   estimate fits the budget.
5. Scores every recorded run and writes the results file and summary.

## What it spends

Each step starts only when the spend so far plus that step's worst case fits under `--max-usd`:

- A participant run's worst case is `--participant-cap` plus the CLI's worst-case desktop minutes
  at $0.00888 a minute (8 CPU, 8 GiB). The participant cap is checked between turns, so one turn
  can pass it.
- An analysis's worst case is the admission estimate `humanish analyze --dry-run` reports for
  that run. The default cap follows that estimate with 10% headroom, bounded by the remaining
  per-brain budget and the CLI's $1,000 limit. A missing estimate refuses automatic sizing.
  `--analysis-max-usd` keeps a fixed per-run cap. `analyze` refuses before sending anything when
  the estimate is higher than its cap. The estimate is conservative and is not a billing cap.
- A `local-agent` participant's model spend has no price. It is recorded as unknown, and the cap
  bounds only its desktop and analysis spend.

On 2026-10-04, four neutral-mission runs cost $3.49 in estimates: participants $0.14 to $0.28,
desktops about $0.01 each, analyses $0.50 to $0.84. Their analysis admission estimates were $1.44
to $1.68 with a 16,384 token output allowance, so `--analysis-max-usd` below that refuses every
analysis.

The default plan, 3 runs per arm with analysis, is about $5.20 at those costs. The cap admits each
step on its worst case, so the sixth analysis needs about $6.70 of headroom: at $6 the dry run
projects 6 runs and 5 analyses, and the default of $7 fits all 12 steps. When a plan does not fit,
the dry run names the smallest cap, in $0.50 steps, at which it does.

The benchmark's automatic cap uses a fixed 16,384-token output allowance for both the admission
check and the analysis, preserving the allowance of earlier benchmarks as the input prompt grows.
For example, a $1.81 admission estimate gets a $1.991 cap when the remaining budget allows it.
An explicit `--analysis-max-usd` keeps the CLI's admission-based output sizing. Automatic analysis
after a user's run uses a $3 limit. Results record the analysis model, prompt version and limits;
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
The matching never reads it.

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

## What these numbers are not

Planted defects are more legible and more reachable than most real defects, so recall here is an
upper bound for an app nobody planted. Repeated runs share a model, persona, mission and app, and
the September records show near-identical sessions, so N runs are closer to repeated draws of one
configuration than to N independent people. The `synthetic-new-user` persona still declares
`accessibility_needs: clear_terminal_output`; it stays unchanged so results compare with the
September runs, and the harness-caused count shows when it surfaces. The clean `app.js` opens with
a comment that names it the clean build, which a participant could read through view-source.
