# Automatic completion retains a participant report

Date: 2026-09-05. Instrument: OpenAI computer use, `gpt-5.6-sol`, desktop
1440×950, synthetic first-time user. Confirmation source: `83360ce`.

## Problem and change

A participant could encounter a broken Save button, recover with Enter, and
satisfy `stopWhen` before they had a chance to speak. A completed task then had
no account of the difficulty. Preserving earlier messages does not recover a
message that was never requested.

After a structured `stopWhen` or dwell stop, the loop now requests one optional
closing report when the provider supports retained conversation history and
time and known budget remain. The OpenAI request disables tools, limits output
to 1,024 tokens, and uses a strict schema separating a summary from encountered
friction. An empty friction list is valid. It makes no further desktop actions,
does not retry, and preserves the original completion reason and task result.
Skipped, failed, incomplete, and unpriced reports remain explicit on the trace.
Stateless/ZDR conversations skip this retrospective request.

## Paired live confirmation

The [reproducible protocol](../../../../bench/feedback-ending-study.md) crosses
working/broken Save with natural/automatic endings, three attempts per cell.
Enter saves in both fixtures. The mission names no defect or hidden criterion.
No attempts were replaced; two development pilots are excluded below.

| Save control / ending | Attempts | Task completed | Participant message | Feedback candidate | Assessment |
| --- | ---: | ---: | ---: | ---: | --- |
| Broken / natural | 3 | 3 | 3 | 3 | All reported unresponsive Save and Enter recovery |
| Broken / automatic | 3 | 3 | 3 | 3 | All three typed reports retained that friction |
| Working / natural | 3 | 3 | 3 | 3 | **Legacy parser false positives:** all explicitly reported no friction |
| Working / automatic | 3 | 3 | 3 | 0 | All three typed friction lists were empty |

All 12 CLI processes exited zero. All 12 runs recorded sandbox teardown;
provider listing after the cohort found no active Humanish sandbox. Recorded
cohort estimate: **$1.016351**, including provisional desktop rates, not an
invoice. One actor took about 209 seconds; successful completion is not a
latency guarantee.

The preceding frozen baseline had 12 diagnostic attempts: nine reached the
task completion point, three failed before completion, and one of the completed
runs subsequently exited nonzero during screenshot cleanup. Both completed
broken/automatic runs had no participant message or candidate; all three
completed working/automatic runs also had none. Cleanup repairs were merged
between cohorts, so process reliability differences cannot be attributed to the
closing report alone. These are small mechanism checks on one task, not a
general defect-recall, precision, human-realism, or conversion estimate.

## Kept confirmation runs

| Cell | Repeat | Run |
| --- | ---: | --- |
| Broken / natural | 1 | `cua-2026-09-05T01-56-18-389Z-38c967e8` |
| Broken / natural | 2 | `cua-2026-09-05T02-01-36-468Z-c6d234eb` |
| Broken / natural | 3 | `cua-2026-09-05T02-02-22-503Z-8405f8f4` |
| Broken / automatic | 1 | `cua-2026-09-05T01-57-00-377Z-345e868c` |
| Broken / automatic | 2 | `cua-2026-09-05T02-00-38-470Z-6f08193e` |
| Broken / automatic | 3 | `cua-2026-09-05T02-03-04-501Z-3ed89f52` |
| Working / natural | 1 | `cua-2026-09-05T01-57-42-389Z-7268ccc5` |
| Working / natural | 2 | `cua-2026-09-05T01-59-56-440Z-07a8504b` |
| Working / natural | 3 | `cua-2026-09-05T02-03-46-516Z-1af3b7d9` |
| Working / automatic | 1 | `cua-2026-09-05T01-58-32-419Z-86cc7bfb` |
| Working / automatic | 2 | `cua-2026-09-05T01-59-14-462Z-09513d4f` |
| Working / automatic | 3 | `cua-2026-09-05T02-04-28-539Z-9a2f220d` |

Bundles and full wire captures remain operator-held and are not committed. The public provider fixtures contain minimal, sanitized excerpts
from typed development pilot `cua-2026-09-05T01-53-04-062Z-189bb3b5`;
their provenance note records the exact transformations.

## Proof and limitations

All 12 confirmation bundles passed `verify` as `share_ready`; all nine
candidates rendered issue drafts without mutating GitHub. This includes the
three false positives: share safety does not establish finding correctness.
The typed pilot also passed this candidate → verify → draft path. Deterministic checks
cover hidden-criterion separation, no further actions, cancellation, one-call
limits, unknown usage, budget exhaustion, invalid reports, redaction, empty
friction lists, retained earlier reports, and actual captured API shapes.

Natural-ending free text still uses the legacy heuristic. The three false
positives above require a separate parser correction; they are preserved in
this receipt rather than relabeled as successful findings. The typed report is
the participant's account and can itself be mistaken; it remains reviewable
against the action trace and screenshots. Dwell behavior has deterministic
coverage, while this live cohort exercised `stopWhen` only.
