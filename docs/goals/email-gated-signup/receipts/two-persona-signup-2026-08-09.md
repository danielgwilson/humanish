# Two participants, same signup: the first real finding, 2026-08-09

The point of a second persona was to stop describing plumbing and start describing people. It
worked on the first run.

**Run:** `cua-2026-08-09T02-31-13-266Z-beada79d`
**Lab:** `humanish/labs/signup-email-verify.yaml` (two lanes, per-lane worlds)
**Subject:** `documenso/documenso` (public, AGPL-3.0), cloned and served in-sandbox
**Participants:** `synthetic-new-user`, `skeptical-power-user`

## The result

Both participants completed the email-gated signup — created an account, read the verification
link in their own inbox, followed it, and reached the signed-in dashboard. Each lane captured
exactly one message, in its own world, with its own address; neither could read the other's mail.

| | newcomer | power user |
|---|---|---|
| outcome | reached the goal | reached the goal |
| turns | 16 | 37 |
| cost | $0.32 | $1.25 |
| captured mail | 1 | 1 |
| reported friction | no | **yes** |

`review.participants`: `2/2 reached the goal, 1 reported friction`.

## What the power user found

The keyboard-first participant reported two defects the newcomer never hit, in its own words:

> The signature step was not reliably keyboard-completable. I could tab to the signature box and
> open the signature modal, and I could tab to the "Type" option, but I could not get keyboard
> focus into the typed-signature entry area. I had to use the mouse to click into that area and
> click Next.

> Signup tab order was confusing because focus first moved through decorative/promotional "Sign"
> buttons on the left side before reaching the actual account fields.

That is a real accessibility finding about a real product, produced by declaring a persona whose
`accessibility` trait is `keyboard_first` and letting it try. The newcomer, driving with a mouse,
had no reason to notice either one — which is exactly why a panel has more than one person in it.

It also cost the power user more than twice the turns to reach the same place.

## It changed the harness

The run immediately exposed a hole in `review.participants`, which had shipped hours earlier.

The tally said `reachedGoal: 2` while the run's own lane summary said `1/2 lane(s) passed`. Both
were right: the participant *did* reach the goal, and the lane did not earn a clean pass because
the actor self-reported a blocker. But a stakeholder reading `2/2 reached the goal` would have
concluded the flow was fine and never looked at the single most useful thing the run produced.

So `ParticipantOutcomes` gained `reportedFriction`, which deliberately **overlaps** the other
counts instead of partitioning them. Someone can reach the goal and still tell you the road there
was broken, and the summary now says both.

A tally built to prevent false greens had produced one, on its first contact with a real study,
and only because the study was run.

## What this does not prove

One run, two participants, one subject, one flow. It shows the persona axis produces findings a
single persona would miss. It says nothing about how often that particular defect appears, whether
a third persona would find a third thing, or how any of this generalizes past documenso's signup.
