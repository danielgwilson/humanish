# Participant assignments and recorded actions — 2026-09-09

Scope: identify a participant's instructions and inspect a particular action
when several actions share the same preceding screenshot. This receipt also
records the current desktop SDK cleanup check included in the release.

## Hosted recording and review

Retained run: `observer-context-app-n2-20260909`. Two synthetic participants
used TodoMVC's JavaScript ES6 app at commit
`ff43b02e59dfa604386bb382034b2cd07c2bcd8a` on separate hosted Linux desktops.
They received the same errands and task goals, with different keyboard-only
and pointer-navigation instructions. These differences do not form a causal
persona comparison.

The pointer participant completed the errands and retained 11 screenshots and
13 UI-action entries. Its final capture shows the renamed task and both errands
active. The keyboard participant's first provider response reached the configured
4,096-token output limit. Humanish retained it as incomplete, with one screenshot
and no executed action. That is not evidence of a keyboard accessibility failure
in TodoMVC. Both allocations were independently confirmed absent after cleanup.

Both streams preserve their own mission, focus and participant-facing task goals
from preparation through the final snapshot. A declared 20-second observation
hold produced four repeated captures in the pointer recording; this is a study
hold, not observed participant hesitation. Text-presence task checks establish
observed text, not persistent object identity by themselves.

The production `observe` server showed the pointer assignment before its first
frame and followed new captures. A subsequent browser walk at 1280px and 390px
touch emulation checked two actual clicks between the second and third captures:
`ui_action-005` and `ui_action-008`, following `screenshot-003`. Selection changed
the event, timestamp and pin while preserving the same image. Keyboard activation,
refresh, save/recall and return to the complete interval preserved the intended
evidence. Screenshot checks waited for decoded images before capture.

Independent review also used the older retained run
`observer-review-journey-n2-20260909`. It found two problems before release:
identical saved action labels, and a clipped participant name on phones. The
recheck confirmed distinct subsecond/recorded-order labels and a visible phone
participant name, with exact action recall and no horizontal page overflow.

## Desktop SDK startup cleanup

Retained probe: `sdk-startup-n2-20260909`, using `@e2b/desktop` 2.4.0 and E2B
2.49.0. Two real desktop allocations received controlled command failures after
Xvfb launch and after XFCE launch. Each preserved the injected startup error,
called the normal SDK kill exactly once, and was independently confirmed absent.
No model calls or replacement allocations were made.

Installed-SDK method-fault tests separately reproduced cleanup running before
Humanish's outer ten-second deadline could begin. The repaired wrapper shares
one bounded cleanup result during creation. Current SDK conformance passes
60 checks; older 2.3.3 and minimum 2.2.3 peers each pass 59, with one newer-only
XFCE readiness check inapplicable. The normal provider kill inherits a request
timeout; the pending local-method test is not proof of an indefinitely hanging
provider request. These checks do not settle ownership before construction or
prove reclamation following an unconfirmed cleanup response.

## Regression coverage and limits

The candidate passes 2,351 core tests, 50 TUI tests, 172 Observer tests,
40 production browser cases, 15 iframe/isolation checks, release packaging and
public-surface checks, plus site build/typecheck and registry parity. Assignment
tests cover all built-in producing routes, redaction, hidden-field exclusion and
legacy absence. Shared-world and terminal assignments do not falsely include the
manifest task protocol those routes do not currently execute.

These are mechanism and usability checks on synthetic studies. They do not
establish organic adoption, physical-device fidelity, screen-reader acceptance,
continuous video, or a success-rate estimate from two participants.
