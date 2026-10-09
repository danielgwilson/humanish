# Study analysis

Study analysis is an independent interpretation of retained participant evidence.
It is separate from the participant's account, recorded outcome, and the run's
deterministic review verdict. Opening an Observer never starts a provider request.
Supported live runs request analysis on completion by default, with a separate
$3 cap on its expected cost. Set `review.analysis: false` to disable that request;
see [automatic analysis](../product/automatic-analysis.md).

## Invocation

```bash
humanish analyze --run latest --max-cost 3 --dry-run --json
humanish analyze --run latest --max-cost 3 --json
humanish observe --run latest
humanish analyze list --run latest --json
humanish analyze show --run latest --json
```

The source must be a verified, completed live run. A dry-run contract bundle is
not a participant study. Here, `analyze --dry-run` means checking an existing
study's input and admission estimate without credentials, a provider request,
or a new analysis artifact. It prints the expected cost, the worst case and the
cap; a refused dry run says why, and names the `--max-cost` that admits it.

The default provider is `openai`; its default model is `gpt-6-astra`, with high reasoning effort. A request sends selected retained text and
captures to OpenAI, without tools, redirects, provider-side response storage, or
automatic retries. `--question` adds a reviewer question; it never changes the
participant assignment. For OpenAI API analysis, `--max-cost` is required, including for dry-run
admission. Admission refuses the request when both its worst case and its expected cost plus a
10% margin are over it; the provider bill is not limited by it.
`--timeout-ms` and `--max-output-tokens` bound the request. A bill above the
worst case or the cap retains valid findings and usage but returns a partial
result and a nonzero command exit, including when that version is reused.

The estimate counts the instructions, evidence packet and result schema at 3
UTF-8 bytes per input token, adds 2,048 framing tokens and each capture's
high-detail image tokens, and prices input at the model's highest input rate.
The expected output is 12,000 tokens plus 1,000 per participant, at most the
output allowance; the worst case spends the whole allowance. A run with more than
16 participants sends one request per cohort and a merge request
([runs with more than 16 participants](#runs-with-more-than-16-participants)),
and the estimate is their sum, each request priced on its own long-context tier.
The merge request's input is its instructions, packet and schema, counted the same
way, plus each cohort's report at that request's whole output allowance; it is
expected to write what one request covering every participant would. `admission` in
`--json` output has `estimatedCostUsd` (the expected cost), `worstCaseCostUsd`,
`admittedCostUsd` (the figure compared with the cap: the expected cost plus 10%,
or the worst case when that is lower), `maxCostUsd`, `inputTokenAllowance` (the
input tokens priced), `outputTokenAllowance` (each request's) and `requests` (the
requests the costs cover: 1, or each cohort's and the merge request; null when the
input or configuration was refused). The dry run's worst case for more than one
request says every request writes its whole allowance and names the cohort and merge
requests, in the words the plan's analysis line uses. On 148 billed gpt-6-astra
analyses the expected cost was 1.08 to 7.3 times the bill, and 1.08 to 1.32
times for those billed $1 or more.
A refusal's message gives the expected cost, the worst case, the cap, and
`humanish analyze --run <id> --max-cost <n>` with `n` the worst case rounded up.

The default deadline is ten minutes for each request. With no explicit output-token limit, analysis
uses 32,768 tokens if admission fits the declared budget, or retains the prior
16,384-token allowance otherwise. Explicit limits are never adjusted. Selection
happens before dispatch; `admission.outputTokenAllowance` exposes it in dry-run,
and the saved configuration, digest and automatic job bind the selected allowance.
This selection never increases the spending limit or starts a retry.
The configured wall-clock deadline covers the entire request, including waiting
for response headers and reading the body. A request-scoped dispatcher prevents
Node's separate fetch timeout from cutting a longer configured deadline short;
it does not change other network requests in the process. Transport failures
retain only an allowlisted cause code, never provider exception text or URLs.
The analysis checks the assigned requirements against the retained end state;
an unverified essential result remains unknown even if the participant reported
success. Findings keep reported concerns and observed recovery distinct across
participants. Other supported models can be selected explicitly, but evidence
reference validation does not certify their interpretation of small visual details.

## Runs with more than 16 participants

One analysis covers up to 128 participants, the most streams it reads from a run
bundle. A request covers at most 16 (`EVIDENCE_LIMITS.cohortParticipants` in
`src/analysis/analysis-limits.ts`). A run with more is split into the fewest
cohorts of at most 16, with participants dealt in roster order: 17 participants
make cohorts of 9 and 8, 24 make two of 12, 40 make 14, 13 and 13, and 100 make
seven. Each cohort's packet is selected under the packet limits below on its own,
so each participant keeps at least the evidence a 16-participant run gives it.
Evidence IDs are numbered across the whole run, so they stay unique.

Each cohort request uses the standard instructions, schema and validation, with
only its own participants' evidence and captures. Up to four run at once for
OpenAI, which keeps four requests at the packet limits under the lowest paid
tier's gpt-6-astra rate limit of 1,000,000 tokens a minute; Codex runs one at a
time. Then one merge request reads the cohort reports, never the evidence or the
captures. It writes the summary, findings, design findings, concern reviews and
limitations for the whole run; the participant reviews are the cohorts' own.
Its findings, design findings and concern reviews may cite only evidence that a
cohort report cites in its own findings, design findings or concern reviews
(`analysis_validation_failed_merge_reference_invalid` otherwise), and the merged
report passes the same reference, membership and basis checks against the run's
whole packet as a single request's report does.

The attempt has one execution start, one receipt and one `analysis.json`, with the
run's participants, coverage and evidence and the summed usage of every request
sent. The artifact schema is unchanged. Its stored limits grew to hold eight
cohorts: 6,400 evidence items, 320 captures and 16 MiB. If a cohort request fails
or is rejected, no further request starts, requests already sent finish, no merge
request is sent and the attempt fails with that request's code, with no findings;
a warning names the cohort's size. A failed merge request fails the attempt the same way. The usage
still counts every request sent. Findings from part of the participants are not
kept as a report on the run.

The first live cohort analysis, on a 24-participant computer-use run, sent two
cohort requests of 12 participants and the merge request in 5 minutes 6 seconds.
Its expected cost was $6.08, 2.3 times its $2.65 bill, and each of its 447
citations resolved in the run's packet. A second analysis of the same run, with
the current merge instructions, billed $1.92, most of its input served from the
provider's prompt cache, and each of its 466 citations resolved. Two runs do not
calibrate the merge request's estimate.

## Explicit Codex account analysis

An existing completed recording can use a separate restricted Codex analyst:

```bash
humanish analyze --run latest --provider codex --dry-run --json
humanish analyze --run latest --provider codex --json
```

This branch runs on Linux x64 and Apple Silicon macOS with any stable Codex CLI release `src/actors/codex/codex-admission.ts` admits (0.154.0 on, except refused releases), a file-backed
ChatGPT account login, and `gpt-6-astra` with low reasoning effort. The participant conversation
is never reused. Selected text and screenshots still go to remote inference;
this is account authentication, not local inference. No API-key, alternate model
or configured-provider fallback occurs. Model access and account allowance are
not established by installation or login alone. Keychain-only login, other
platforms and CLI versions are refused before a turn; they are not silently
converted to API authentication.

Omit `--max-cost` and `--max-output-tokens` for Codex. Numeric declarations are
rejected because this transport does not enforce them. `maxCostUsd` and
`maxOutputTokens` are stored as null. The existing evidence bounds, one analyst
turn per request (one per cohort, and the merge request), bounded response bytes
and whole-operation timeout still apply. One turn is not a claim of one upstream
billed request; account limits apply. Reported
tokens remain inspectable, but dollar estimates, admission dollars and rate dates
remain null. Interrupted token observations remain explicitly incomplete.

The dry-run validates only local evidence and configuration. It does not check
the CLI, login, model access or quota and does not start a provider request.
`doctor --study <study>` checks the selected analyst setup without a model call.
Failures leave the recording available; inspect `analyze show` and the attempt's
accounting before an explicit `analyze --provider codex --rerun`.

The persisted identity is the required qualified execution profile: transport,
authentication and billing class, requested and required resolved model, effort,
tool-policy revision and CLI version. The launcher must confirm it before the
turn. A failed pre-dispatch attempt does not prove the CLI or model was observed.
These fields participate in the configuration digest, preventing reuse across
providers or changed execution policies. Historical API configurations, hashes
and corrections are read without inserting new defaults.

## Evidence interpretation

Analysis distinguishes participant actions from harness setup and accounting.
Runtime credentials or model usage do not establish that a participant made an
external call while performing their task. Observations with an action basis
must cite an action-bearing source; invalid source bases are rejected with the
attempt's status and known usage retained.

Identical source input, configuration, and prompt version reuse a current valid
analysis. `--rerun` creates another immutable version. Failed attempts do not
hide earlier valid findings. Ctrl-C cancels the request; usage remains unknown
when the provider did not report it. Cancellation cannot undo an already accepted
provider request.

Decoded participant context, evidence text, and the reviewer question are checked
for known sensitive-text patterns before dispatch. JSON escaping cannot bypass
that check. Image bytes are not treated as text for pattern matching.

Only one analysis command can own a run's `.analysis-lock` directory. Interrupted
locks are not stolen using stored PIDs. After confirming the owning command has
stopped, an operator can remove the empty lock directory and retry.

## Evidence and findings

Each request's packet admits up to 16 participants, 800 evidence items, 40 PNG
captures, 160 KiB of text and 20 MiB of images. Individual source files, image
dimensions and result sizes have separate limits. Count and text budgets are
distributed across included participants, with unused capacity from short
sessions available to longer ones. Reclaimed capture slots go first to eligible
participants with fewer admitted images, including those deferred by their
initial image-byte reservation. Capture selection prioritizes session endings
and beginnings, context around recorded failures, the capture preceding the
ending, and spread across each whole session. Adjacent ending context can retain
results moved out of view by a final scroll or navigation. Failure priority uses structured source status, not application-specific
keywords or image interpretation. Unflagged visual errors may still be omitted.
Bounded reads and the total image byte limit can reduce coverage further.
Selected entries retain their original source order, frame and event identities;
this is not a statistically representative sample. Selection
omissions and unreadable or invalid capture files make declared coverage
incomplete. Coverage records file availability and selection; it does not
certify visual legibility, correct interpretation, or exhaustive issue discovery.

New packets declare `captureVersion: 2`, bound into their input digest. They
include captures attached to `screenshot` and scripted `ui_action` events,
preserving the original action IDs and evidence basis. Error notices that refer
to an earlier capture retain that context without creating another frame.
Scripted participants use their recorded `ui.intent` goal when no participant assignment
exists. Missing assignments and declared captures without supported trace
references are explicit omissions. Artifacts without `captureVersion` continue
to validate against the original capture mapping; previously saved selections
are not recomputed or rewritten.

The standard review covers session summary, apparent intent, observed outcome,
friction, dead ends, recovery, and participant feedback. Findings are ordered by
observed task impact, replication among exposed participants, and recovery.
Impact and confidence remain separate. There is no numeric frustration or
universal priority score.

The standard review also accounts for material participant concerns before
ranking findings. Reported uncertainty can be useful even when the interface is
correct or study setup may explain it. Claims distinguish that experience from
an established product defect, preserve consequential recoveries, and check
participant accounts against the actual assignment and captured state.

New results include `concernReviews`: evidence-linked observations with a
`finding`, `context`, or `unsupported` disposition and a concise reason. A finding
disposition references an existing local finding ID; other dispositions use null.
The Observer's **Concerns considered** disclosure exposes these decisions and
their original evidence. There is no required finding count or inventory of every
thought. Older reports may omit this field and remain readable. The disclosure
is model-generated assessment, not an independent completeness audit or a human
reviewer annotation.

## Headlines and design findings

The `study-evidence-7` prompt writes each finding twice. `headline` is one plain sentence about what
happened, for a designer, product manager or developer who did not watch the session.
`experience` is one to three plain sentences: what the person tried, what got in their way, and
how it seemed to feel. Neither names participant or evidence IDs. A concern known only from what
participants said still reads as something they said. `title`, `summary` and `observations` keep
their evidence-level wording, and validation applies to them as before.

The same prompt adds `designFindings`: problems a product designer would notice in the supplied
captures, whether or not a participant mentioned them. Each has an `id` (`D1`, `D2`, ...), a
`headline`, the `screen` in plain words, what a designer would `notice`, `whyItMatters` to a
person using the product, one `suggestion`, a `severity` (`major` when it misleads or blocks,
`moderate` when it slows or confuses, `minor` when it is polish), a `confidence`,
`seenByStreamIds` and `evidenceIds`. Validation rejects a design finding that cites no retained
capture, cites evidence outside the packet, repeats an ID, or lists a participant in
`seenByStreamIds` without a cited capture of that participant. An empty list means the review found no design
problem in the captures. The model judges legibility and size from images alone; it does not
measure text or control sizes.

New provider responses must include `headline` and `experience` on every finding and a
`designFindings` list. A stored artifact with prompt `study-evidence-7` or later must carry them
too. Artifacts from earlier prompts load without them and render by title and summary. The
Observer applies the same prompt-version rules and the same field limits when it reads a saved
analysis, and treats an analysis that breaks them as unavailable.

The narrative scrub removes a run's known transient values, such as a received one-time code or
link, from every generated text field. It finds each value as written and in its encoded forms:
percent-encoded, JSON-escaped, base64, base64url and hex, and where escapes split it. Base64 and
hex forms are searched from 6 characters. A value of 4 bytes, such as the code `7439`, is found
in base64 written whole (`NzQzOQ` or `NzQzOQ==`) and not inside a longer base64 run, where 4 or 5
characters of its encoding do not depend on the bytes around it;
`tests/evidence/secret-scrub.test.ts` records the case. The cost of the short forms is
over-redaction: an identifier that holds a short value's base64 loses that part, as
`aMTIzNAz` becomes `a[REDACTED_SECRET]z` while the code `1234` (`MTIzNA`) is registered, since a
match cannot tell whether the identifier came from the value. In the text of 9 real runs, no 6-
or 7-character form of any 4-, 5- or 6-digit code occurred. Run evidence is scrubbed for the same
forms. A field
with a value is stored decoded with the value replaced; a field without one keeps its spelling. A
value inside a bracketed span, such as `[REDACTED_373433393231]`, is found too: only the markers
humanish writes (`[REDACTED_SECRET]`, `[REDACTED_LOCAL_PATH]`, `[REDACTED_RUNTIME_PATH]`,
`[REDACTED_PROMPT_TEXT]`, `[REDACTED_LOBBY_CODE]`) are left as they are. If another reading of
the stored field still holds a value (decoded once more, with percent escapes as UTF-8, with
transfer escapes expanded, or with Latin-1 characters read as UTF-8 bytes), as for a value encoded
twice, the whole field becomes `[REDACTED_SECRET]`. A known value in any of
these forms in an ID, enum or reference refuses the response.

When a reviewer amends a finding, its headline and experience describe the replaced claim.
Text output, the Observer and feedback drafts show the reviewer's claim in their place and say the
finding was corrected; the stored analysis keeps the original.

Every observation cites packet-local evidence IDs. The model cannot choose a
filesystem path or fetch another resource. Validation checks participant
membership, unique counts, quote fidelity, evidence type and reference
integrity. Visual claims require retained captures; screenshot-free evidence
opens its original event. These checks do not prove that every interpretation
is correct or every consequential issue was found.

A rejected response keeps `result` null and records only an allowlisted code in
the artifact's existing `error` field. The code distinguishes schema rejection,
generated-text scrubbing, an unexpected validation exception, or the first
failed reference rule (for example, an invalid quote or observation reference).
It never includes provider output, exception text, evidence values or IDs.
Historical artifacts with the generic `analysis_validation_failed` code remain
valid and unchanged.

A rejected response is never stored in the run directory or in any shareable
artifact. For diagnosis, humanish keeps it locally at
`.humanish/analysis-diagnostics/<run>/<analysis>.json`
(`humanish.analysis-rejected-output.v1`). The record holds:

- the run and analysis IDs, the model and the prompt version;
- the allowlisted code and every failed rule code;
- the response, scrubbed. Every string and key loses known transient secret
  values, including their percent-encoded, escaped and base64 forms, and then gets
  shape redaction. A number or boolean equal to a known value is replaced. A
  string with no known value keeps its original spelling.

When validation ran, the response is the one validation saw, after the narrative
scrub. A schema or scrub rejection keeps the parsed response. An unexpected
validation exception keeps nothing.

The directory sits outside every run directory, and export, verify and the
Observer read only run directories. `humanish analyze` returns the file's path as
`rejectedOutputPath` and prints it, and so does a run's automatic analysis.
Each write removes all but the newest 20 records across runs. It removes a
record only while its directory is still the listed one, so a directory
replaced by a symlink after listing is left alone. The record's
feedback quotes cite evidence IDs that the run's own `analysis.json` resolves.

Participant reviews cite distinct packet-local evidence IDs belonging only to
that participant's stream; source event IDs are not citation IDs. Shared
interactions can cite multiple included participants in findings and concern
reviews under the existing exposure rules. The `study-evidence-6` prompt made
this distinction explicit without changing the validator or historical reports.

Elapsed replay time starts at the first retained capture. It is not a video
offset. Nonvisual events retain event identity without invented frame offsets.
Scripted captures without recorded timestamps keep null analysis times; any
uniform playback pacing is an estimate, not an observed duration.

Finding previews select from the finding's cited entries. They prefer a capture
directly cited as visual evidence, then the number of distinct visual/action
observations citing it; equal support keeps citation order. Duplicate claims do
not increase support. This is a display heuristic, not a confidence score or a
guarantee that the selected capture is the most relevant. Context-only and
nonvisual evidence retain their basis and original event. All cited moments stay
available, with exact recording links.

A finding with a headline leads its Observer row with the headline and its open panel with the
experience. The title, summary, assessment and observations sit in a closed **Evidence**
disclosure beneath. A **Design findings** section follows the ranked findings, grouped by
severity, with each cited capture as a thumbnail that opens that frame. Findings without a
headline render as described below.

Confidence, recovery and the first full evidence limitation remain visible when
a finding opens. Exposure and remaining unique limits are one disclosure away;
observation details retain each original claim and its specific limitation.
This presentation does not rewrite the saved analysis or reviewer corrections.

## Participant impressions

A computer-use participant's closing impressions (`ActorTrace.impressions`) reach the packet as
ordinary `message` entries of that participant's stream, one per impression, with text
`Impression (<kind>): <text>`. They are quote-eligible and attributed by `streamId`, so feedback,
participant_statement observations and design findings can cite them under the existing rules.
Selection admits them right after the participant's last entry, ahead of the rest of its
session. The evidence mapping and `captureVersion` are unchanged.

The `study-evidence-8` prompt adds one paragraph: impressions are the participant's own opinions,
used as participant statements, and an `unlike my work` impression together with a capture of
that screen is a strong design finding. Validation is unchanged. A design finding still needs at
least one cited capture, so an impression plus the capture of its screen makes a design finding,
and an impression alone supports only a finding about what the participant said.

## Durable records

The frozen `humanish.observer-data.v1` schema is unchanged. A companion
`humanish.study-analysis.v1` artifact records source/config/input hashes,
participant context, evidence manifest, coverage, provider/model/prompt version,
status, usage and validated findings. The Observer's projection of it,
`observer/study-analysis.json`, also carries `spend`: what every analysis
request of the run cost, as [study costs](study-costs.md#one-runs-cost)
describes:

```text
.humanish/runs/<run>/
  analysis/<analysis>/analysis.json
  analysis/<analysis>/corrections/<correction>/correction.json
  analysis-attempts/<analysis>/start.json  # before transport; outcome initially unknown
  analysis-attempts/<analysis>/receipt.json
  observer/study-analysis.json
  analysis-automatic/job.json  # post-run lifecycle; never a retry instruction
```

The optional automatic job is separate from the immutable analysis. Its view
binds terminal state to the exact execution receipt and report. A stale or
unverifiable job remains unknown; reading or exporting it never dispatches.
Automatic job metadata is omitted from shared derivatives. A job refused for its
cost also records `admission` (`expectedCostUsd`, `worstCaseCostUsd`,
`maxCostUsd`), which `review` and the Observer read; other jobs omit it. See
[automatic analysis](../product/automatic-analysis.md).

Version and correction directories are claimed exclusively; publication is
atomic. Source evidence is not rewritten. Minimal execution receipts retain
model, budget, status and known usage even if source changes prevent report
publication. They contain no question, participant text, images, or findings.
`analyze list --json` includes these receipts.

New requests first claim their execution directory and atomically publish
`start.json` (`humanish.analysis-execution-start.v1`) before provider transport.
It contains only the attempt/run IDs, input/config/source digests, prompt version
and timestamp. The live caller retains a binding to that exact directory and
publishes the final receipt once. A start without usable final accounting means
dispatch and spend remain unresolved; it is not proof that a provider charged.
A cancellation before transport can finalize with `usage.dispatched: false`.
Admission refusals, missing credentials and rejected dispatch guards do not
create a potentially paid attempt. Reuse does not create a new start.

`humanish stats` reads all retained execution IDs, including failed, cancelled,
unpriced and unresolved attempts. Report/receipt copies and automatic reuse
count once per run and analysis ID. Legacy report usage can contribute without
a fresh source or valid findings, but the missing execution receipt is labeled.
This accounting read never approves findings or requests a provider. See
[study cost statistics](study-costs.md) for the additive JSON contract and
run-date attribution.

Analysis and execution-history directories each admit 256 entries, including
interrupted writes; correction history admits 256 entries per analysis. A new
attempt requires readable inventories with room for its records before dispatch.
Valid reuse remains available at capacity. The command does not remove old
versions automatically. A present correction that cannot be read or validated
blocks sharing and feedback promotion until the history can be checked.

States distinguish no analysis, complete with no findings, complete with
findings, partial, failed, cancelled, stale and invalid. A copied or modified
source cannot silently inherit a current analysis. Saved HTML and the HTTP
companion project validated records; generic HTTP serving of producer-owned raw
analysis/correction JSON, execution receipts, atomic write temporaries and locks
is disabled. Existing adapter captures and logs retain their contained routes.

## Reading findings

`humanish review` prints a run's analysis findings after its participant review, and
`humanish analyze show` prints them alone. Each finding leads with its headline and experience,
then shows its title as `evidence:`, its impact, confidence and recovery, the participants it
affected out of those exposed, the frames its evidence cites with their time since the first
retained capture, the capture files, its next step and the latest human review note. A finding
without a headline starts at its title. Design findings follow, most severe first, each with its
screen, notice, why it matters, suggestion, who saw it and its capture files. A live run's human
output ends with up to three findings and up to three design findings, one line each, and the
`review` command that prints all of them. `analyze show --json` prints the validated
analysis record and its corrections, as before. Reading findings never starts an analysis.

`review --json` carries the same view as its `analysis` field, schema
`humanish.analysis-findings.v1`, built in `src/cli/findings.ts`:

| Field                                                                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                                                       | `humanish.analysis-findings.v1`.                                                                                                                                                                                                                                                                                                                                                        |
| `runId`                                                                        | The run the view reads.                                                                                                                                                                                                                                                                                                                                                                 |
| `state`                                                                        | `ready`, `stale`, `running`, `none`, `skipped`, `failed`, `dry_run` or `unavailable`. Only `ready` and `stale` carry findings.                                                                                                                                                                                                                                                          |
| `reason`                                                                       | The stable code behind a state other than `ready`, or null: an automatic analysis reason such as `AUTOMATIC_ANALYSIS_KEY_MISSING`, a failed attempt's error code, or a load warning such as `ANALYSIS_SOURCE_CHANGED`.                                                                                                                                                                  |
| `message`                                                                      | What happened, in words.                                                                                                                                                                                                                                                                                                                                                                |
| `next`                                                                         | The command that gets findings for this run, or for a dry run the command that starts a live one. Null when no command can, as for a run whose participants left no evidence.                                                                                                                                                                                                           |
| `analysisId`, `status`, `provider`, `model`, `completedAt`, `estimatedCostUsd` | The analysis version `analyze show` selects: the newest ready one, else the newest stale one. Null without one.                                                                                                                                                                                                                                                                         |
| `runPath`, `path`                                                              | The run directory and the version's `analysis.json`, relative to the project directory.                                                                                                                                                                                                                                                                                                 |
| `summary`, `limitations`                                                       | The analysis's own summary and limitations.                                                                                                                                                                                                                                                                                                                                             |
| `findings[]`                                                                   | Highest priority first: `id`, `headline` and `experience` (null in analyses before `study-evidence-7`), `title`, `summary`, `impact` (`blocked_task`, `friction`, `recovery`, `uncertain`), `confidence` (`low`, `medium`, `high`), `recovery` (`recovered`, `not_observed`, `unknown`), `affected[]` (`streamId`, `label`), `exposedCount`, `evidence[]`, `nextStep` and `correction`. |
| `findings[].evidence[]`                                                        | Each cited item once: `id`, `streamId`, `kind`, `bases` (how the observations used it), `frame` (the latest retained capture's index from 0, null before any capture), `elapsedMs` (time since the first retained capture, not a video offset), `at` and `capture` (the file relative to the project directory, null for nonvisual evidence).                                           |
| `findings[].correction`                                                        | The latest `analyze correct` note on that finding version (`status`, `reason`, `replacementClaim`), or null. When `status` is `amended`, `replacementClaim` replaces the finding's headline and experience.                                                                                                                                                                             |
| `designFindings`                                                               | Most severe first: `id`, `headline`, `screen`, `notice`, `whyItMatters`, `suggestion`, `severity` (`major`, `moderate`, `minor`), `confidence`, `seenBy[]` (`streamId`, `label`) and `evidence[]` (as `findings[].evidence[]`, without `bases`). Null without an analysis result, or for an analysis written before design findings.                                                    |
| `warnings`                                                                     | Load warnings for the selected version.                                                                                                                                                                                                                                                                                                                                                 |

The states without findings:

- `running`: the automatic analysis is queued or running. `next` is `review` again.
- `skipped`: the automatic analysis was skipped or refused, for example without
  `OPENAI_API_KEY`, or the run's study file sets `review.analysis: false`
  (`AUTOMATIC_ANALYSIS_DISABLED`, read from the file when the view is built). `next` is
  `analyze --max-cost 3`, which runs an analysis anyway. For an analysis refused for its
  cost, the message gives the expected cost, the worst case and the cap, and `next` sets
  `--max-cost` to the worst case rounded up.
- `failed`: the latest attempt failed or was cancelled and no usable version exists. `next`
  reruns it with the same analyst, `--provider codex` for the Codex account analyst.
- `none`: no analysis ran for this live run and nothing records why, for example a run that
  started from a library call, or one whose study file has moved or changed id.
- `dry_run`: a dry run has no participant evidence to analyze. `next` is `run` with the run's own
  study when its file sets `mode: live`, else `run try-live` when the project has that starter study
  with `mode: live`, else `run` with the run's own study, and the message says to set `mode: live`
  in its file first. A preview study only dry-runs, and a run with none of these names
  `study list`.
- `unavailable`: the run or its analysis records could not be read or checked, or the analysis
  text matched a sensitive-text pattern (`ANALYSIS_SENSITIVE_TEXT_QUARANTINED`), which the
  Observer withholds too.

`stale` lists the findings with a warning: the run's evidence changed after the analysis, and
`next` requests a new one. `analyze show` without `--json` exits 2 when the JSON form would.

## Human review and sharing

```bash
humanish analyze correct --run latest --analysis <id> --finding F1 \
  --status confirmed --reason "The cited captures reproduce the blocker."
humanish analyze correct --run latest --analysis <id> --finding F1 \
  --status amended --reason "The claim was too broad." --claim "A narrower supported claim."
humanish feedback issue --run latest --analysis <id> --finding F1 --repo owner/repo
```

Corrections append against exact analysis and finding hashes. Confirming one
version does not approve a later claim. Dismissed findings cannot become feedback
drafts; amendments preserve the original and record the replacement. A reason or replacement
claim that matches a sensitive pattern is refused. When the correction is made inside the run's
own invocation, one that holds a known transient value, as written or encoded, is refused too; a
separate `analyze correct` command has no transient values to check against. Feedback
drafts include source/version/evidence references and remain explicitly
independent of participant-authored candidates. No command above posts to GitHub.
Each analysis has room for 256 correction inventory entries, including interrupted
writes. A full or unsafe inventory refuses a new correction before creating its
entry; prior records remain unchanged. Analysis and correction commands share the
run lock so concurrent writers cannot overrun that bound.

The existing sharing gate scans source and derived text. Export and feedback
also check the exact in-memory analysis snapshot they include. Sensitive derived
text blocks sharing and is quarantined from Observer, while independently
verified source recordings remain viewable. Filesystem containment failures
still fail closed. Valid failed/cancelled history alone does not downgrade
sharing.

Redacted bundle export omits analysis, corrections and execution receipts and
records that omission in derivation provenance. Changed source bytes require
new analysis; old hashes and review approvals cannot survive redaction. Ordinary
legacy evidence under `analysis/` remains part of the recording and follows the
normal redaction and sharing checks.
