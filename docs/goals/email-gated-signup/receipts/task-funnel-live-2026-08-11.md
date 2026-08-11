# The study emits its funnel, and every run that proved it also fixed the harness

**Date:** 2026-08-11
**Lab:** `humanish/labs/signup-email-verify.yaml` (live copy with `mode: live`; final run adds `policies.redactScreenshots: true`)
**Subject:** documenso/documenso@962cffc9f546 (public, AGPL-3.0; cloned and served in-sandbox — documenso is the application studied, not a Humanish adopter or endorser)
**Humanish:** 0.41.0 + the day's merged fixes (#417 task funnel, #418 feedback candidates, #419 budgets/#299, #421 scroll+tab state), released as 0.42.0

Four consecutive live two-participant runs of the same protocol — three tasks, each
with a participant-facing goal and a researcher-facing URL criterion the participant
never sees. The sequence is the receipt for two claims at once: the funnel works, and
real runs find harness defects that no dry run or deterministic test had found.

## Run 1 — `cua-2026-08-11T07-46-40-063Z-7c98bd96` (~$1.50)

First contact for the wired funnel (#417) and the participant-report feedback
candidates (#418). Both participants completed signup → verification mail →
signed-in dashboard; the keyboard-first participant reported the signature
keyboard-accessibility defect unprompted (its third independent observation), and it
became `feedbackCandidates[0]` in the bundle — the first browser-route feedback
candidate ever produced.

The funnel read `reach-signup 2/2 · read-verification-mail 2/2 · reach-dashboard
0/2` under final screenshots showing both participants ON the dashboard. Root cause:
a `done` turn takes no actions, so the loop's observe-after-actions cadence never
saw the final state. Fixed the same hour (closing observation, #419) with a
deterministic regression test.

## Run 2 — `cua-2026-08-11T08-05-14-298Z-15939921` (~$1.50)

On the closing-observation fix — and still `reach-dashboard 0/2`. The final
screenshot answered it: **two tabs**. Documenso's verification link opened a new
tab, and the CDP state observer was pinned to the launch tab's target forever, so
the observed URL froze the moment the participant left tab 1. That blinded not just
the funnel but `stopWhen` on this route. Fixed in #421: the state observer follows
the most-recently-active page target; the geometry observer keeps its launch-window
pin. `verify` green, 16/16.

The keyboard finding reproduced again (fourth observation), with a new detail worth
having: the signature modal's Upload mode opens a native file picker that is easy to
trigger accidentally during keyboard/mouse recovery.

## Run 3 — `cua-2026-08-11T08-20-42-171Z-6c1684c0` ($1.01)

On the tab-follow fix:

```
verdict: pass — 2/2 reached the goal;
tasks: reach-signup 2/2 · read-verification-mail 2/2 · reach-dashboard 2/2
```

Turn-stamped per-participant funnels on each trace, the study roll-up in
`review.tasks` with a denominator on every number, and the same line on the
Observer's verdict banner. `verify` green.

## Run 4 — `cua-2026-08-11T08-30-34-550Z-2dc73d59` (blurred capture, $2.39)

Identical protocol with `policies.redactScreenshots: true`, because the feedback
pipeline's share-safety gate correctly refuses drafts from raw-screenshot bundles
(`local_only` → `HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED` — fail-closed as designed;
capture-time redaction is the only path until redact-on-export, #136). Result:
verdict pass, funnel 3/3 on both participants again, `verify` green with
**`shareSafety: share_ready`** — the first share-ready bundle of this study — and
`humanish feedback draft` produced the honest live draft (participants and tasks
lines, denominators intact), never the dry-run letter. Neither participant reported
friction this run, so no participant-report candidate; the finding's candidate
lives in runs 1 and 2.

## The finding, in the participant's own (redacted) words

From run 2's `feedbackCandidates[0]`, the fourth independent observation across
three humanish versions:

> The signature control did not provide a usable keyboard-only path for
> entering/drawing a signature. Tab navigation opened the signature modal and
> cycled between modes, but I could not complete the signature by keyboard. I had
> to use the mouse to draw it, which I would treat as an accessibility defect.
>
> The signature modal's Upload mode opened a native file picker during
> keyboard/mouse recovery, which was easy to trigger accidentally.

Whether this gets filed upstream is the maintainer's call; the draft machinery to
carry it is now proven end to end.

## What these four runs established

- **The funnel is real**: declared tasks complete from observations, never from
  narration, and "where did people get stuck" is now a number with a denominator on
  every surface a stakeholder reads.
- **Participant reports become feedback**: a self-reported blocker turns into a
  `target-app` feedback candidate quoting the participant's own (loop-redacted)
  words, with trace, final screenshot, and comms thread as evidence.
- **Real runs remain the only way to find this class of defect.** Two harness bugs
  (final-state observation, tab pinning) survived 1,500 deterministic tests and two
  prior live studies, and fell out of funnel numbers that refused to agree with
  screenshots. The instrument catching itself lying is the product working.
- **The keyboard-accessibility finding is now reproduced across four independent
  sessions** on three humanish versions, with a second distinct sub-finding. It is
  as solid as a synthetic-panel finding gets.
