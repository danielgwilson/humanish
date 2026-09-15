# Automatic analysis: Humanish-on-Humanish study

Date: 2026-09-15. Candidate source: `bac99d6`. Package: `humanish@0.90.0`.
Tarball SHA-256: `5bfaced1ca2bac9ba3ca05ab7fa23d3c7840c3be0c71ee768c7bbbf1bd484651`.

A real autonomous terminal researcher used Humanish to run and review a prepared
fictional reading-list study. A separate computer-use reviewer then inspected
its actual Observer. Released `0.89.1` provided the baseline; fresh participants
used the packed candidate. The outer study harness remained `0.89.1` in both
arms. The inner browser task was deterministic, not a model-driven participant.

## Observed difference

The app displayed a save confirmation without showing the requested book under
Saved books. Both versions retained four byte-identical screenshots. The
baseline analysis admitted zero captures and no assignment, declared complete
coverage and returned zero findings. Its researcher found the discrepancy by
opening the raw screenshots. Its visual reviewer could not play those captures.

The candidate admitted all four captures and the recorded scripted goal,
automatically returned one supported finding, and preserved the task outcome as
unknown. The researcher made no separate analysis request. The visual reviewer
opened the finding, compared the before/after captures, checked Feedback,
returned to Findings and confirmed that recording and analysis were finished.
They correctly distinguished those states from the unverified app task.

| Evidence | Baseline | Candidate |
| --- | --- | --- |
| Retained screenshots | 4 | 4, identical bytes |
| Captures included in analysis | 0 | 4 |
| Recorded goal included | No | Yes |
| Independent findings | 0 | 1 |
| Provider analysis requests | 1, explicit | 1, automatic |
| Researcher shell commands | 32 | 22 |
| Reviewer playback | No projected frames | Four frames; cited moments verified |

Command counts describe these sessions; they are not a general efficiency
estimate. Both researchers ultimately recommended investigating the same
visible discrepancy. The candidate made that recommendation available through
the intended findings-and-recording workflow.

## Retained runs

- Aligned baseline researcher: `terminal-2026-09-15T04-21-55-799Z-fde0921c`.
- Baseline inner study: `scripted-2026-09-15T04-22-37-214Z-3b0c22d3`.
- Baseline visual reviewer: `cua-2026-09-15T04-32-22-771Z-66a83551`.
  This reviewer used a separate earlier recording of the same frozen app and
  scenario, `scripted-2026-09-15T04-14-59-073Z-d85f5b42`.
- Candidate researcher: `terminal-2026-09-15T05-04-31-260Z-579dfc37`.
- Candidate inner study: `scripted-2026-09-15T05-05-46-483Z-970bd322`;
  analysis `analysis-6bdfbe35-2394-496e-8f5e-53d5e7c9cf7a`.
- Candidate visual reviewer: `cua-2026-09-15T05-09-25-262Z-6b4ad42b`.
- Independent installed-package host check: `observer-automatic-host-proof`;
  analysis `analysis-11d6da41-ab6a-4994-a0bc-d86054e96cf9`.
- Candidate release first-contact gate:
  `terminal-2026-09-15T05-05-00-186Z-9791cfe5`.

Generated recordings, transcripts and screenshots are retained outside tracked
source. Original local-only screenshot grades were preserved. Owned sandbox
cleanup is recorded by the study runners; the host check left no owned app,
Observer or browser process running.

## Other verification

The installed host check compared all 442 package files against the tarball,
observed real analysis progress and completion, verified every cited image and
action at desktop and 390px, and kept the current recording route and shell
unchanged. Reload retained one execution receipt. The CLI-produced static HTML
and local-only export showed the finished report without another provider call.
The original recording stayed unchanged.

`release:check` passed 2,820 core tests and 61 TUI tests, plus typechecks, builds,
CLI startup/preflight, public-surface scanning, skill discovery and npm contents.
Ten core cases remain intentionally skipped. The separately built Observer suite
passed 284 tests. The browser coverage suite includes shell transitions and
scrubber alignment at desktop/phone and 1x/2x device scale. Site typecheck, build,
registry check and generated CLI documentation checks passed.

Independent source review reproduced and closed cancellation fallback, recording
replacement and stale saved-HTML defects. Native Fable 5.1 code and screenshot
review found no remaining blocker in its inspected scope. Reviews do not replace
the actual package and participant receipts above.

## Limits

There was one successful fresh participant per role and arm. Early provisioning
failures and a baseline output-limit interruption are retained separately,
not counted as successful trials. The operator configured candidate opt-in before
the researcher began; unaided configuration discovery is unproven. Several
related changes shipped together, so this does not isolate their individual
contributions or estimate human completion rates, defect recall or adoption.

The analysis costs were estimates: $0.070497 for the aligned baseline,
$0.209767 for the candidate and $0.215105 for the separate host check. These are
not total study costs or provider invoices; outer researcher runtime cost was
not fully measured. Original scripted captures lack timestamps, so playback
pacing remains an estimate. The reviewer reported hesitation over timing and
recorded-pass versus analyzed-outcome labels, then reached the correct
interpretation. Qualitative feedback was appropriately absent from the scripted
inner task. Physical touch and broad browser compatibility were not studied.
