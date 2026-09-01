# Is the persona axis load-bearing? Three live runs: 3 of 3 keyboard-first participants hit a modal no mouse participant noticed

Date: 2026-09-01, humanish 0.66.0, `openai-computer-use`, subject drawDB (`drawdb-io/drawdb`,
cloned and served in-sandbox). Lab: the committed `humanish/labs/persona-contrast-demo.yaml` with
`scenario.mode: live` (the `.humanish/labs/persona-contrast-live.yaml` copy the lab's own text
describes). One mission for both lanes; the persona is the only declared difference.

The question has been open since 2026-08-09, when a keyboard-first participant found a
signature step in a different app that a mouse-driving participant had no reason to notice
(`docs/goals/email-gated-signup/receipts/two-persona-signup-2026-08-09.md`). That was n=1.

## Result

| run | lane | persona | turns / actions | outcome |
|---|---|---|---:|---|
| `cua-2026-09-01T19-35-50-833Z-f390a70a` | impatient-expert | `skeptical-power-user` (keyboard_first) | 8 / 25 | blocked before creating anything |
| | patient-newcomer | `synthetic-new-user` | 23 / 64 | created two tables and the relationship |
| `cua-2026-09-01T19-36-20-743Z-d133dcea` | impatient-expert | `skeptical-power-user` (keyboard_first) | 7 / 20 | blocked before creating anything |
| | patient-newcomer | `synthetic-new-user` | 17 / 48 | created two tables and the relationship |

Cost: $0.67 and $0.45 for the two runs, four participants. Wall clock 292 s and 245 s.

Both bundles: `verdict: fail`, `participants: 2 total, 1 reached the goal, 1 blocked, 1 reported
friction`. The blocked lane is refused as a credible pass (the participant claimed done while
describing a blocker), which is the correct reading here: it was blocked and said so.

## The finding, in the participants' words

Run 1, keyboard-first:

> Blocked before diagram creation. The mandatory "Choose a database" dialog is not keyboard
> accessible: Tab skips every database option and the Confirm button. Focus escapes to controls
> behind the modal. No visible focus indicator or keyboard selection path exists. Confirm remains
> disabled until a mouse-only database card is selected.

Run 2, keyboard-first, independently:

> The required "Choose a database" modal has no keyboard-focusable database options. Tab moves
> focus to controls behind the modal instead of trapping it inside. Arrow keys and Enter cannot
> select a database; Esc does nothing. Confirm remains disabled.

The same modal, the same failure, described twice by two participants who shared nothing but a
persona. The mouse-driving newcomer in both runs clicked a database card, confirmed, and went on to
report the friction the provider-key and keyless cold-install runs found earlier today (new tables
stacked at one canvas position; both newcomers used Auto arrange to get past it).

## A third run, same day, with blurred capture

`cua-2026-09-01T19-51-09-995Z-9c1caf85` ($1.88, 375 s; `policies.redactScreenshots: true` so the
bundle is share-ready). Both lanes reached the goal this time. The keyboard-first participant hit
the same modal, and its affordance record shows how it got past: 84 actions, 69 keyboard, 4 pointer.
Its closing report: "Accessibility defects: the database chooser, confirmation control, and code
editor were not keyboard-accessible; focus escaped behind the modal, requiring mouse clicks."

So across three runs: 3 of 3 keyboard-first participants hit the modal and described it; 2 of 3
stopped there; 1 of 3 broke its own keyboard-first rule with four clicks, finished, and said so.
3 of 3 mouse-driving newcomers never mentioned it. The finding is replicated three times; the
participant's response to it varies, which is what the affordance record is for.

## What this says

- The persona axis changed the outcome, not the phrasing: one arm cannot start, the other finishes.
  A one-persona study of drawDB would have reported "two tables, some overlap, done".
- The keyboard-first participant stops early and cheaply: 7 to 8 turns against 17 to 23. A panel's
  cost is dominated by the participants who get through.
- N=2 per arm. The two blocked reports agree on every mechanical detail: Tab, focus escape,
  disabled Confirm.

## Not verified

Whether the modal is reachable by keyboard in a way neither participant found (a hidden skip link,
a different key). The claim here is what two keyboard-first participants could do, not a WCAG audit.
