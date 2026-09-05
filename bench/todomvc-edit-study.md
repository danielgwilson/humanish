# Rebuild the TodoMVC Edit patch and author a comparison

The [September 5 receipt](../docs/goals/computer-use-actor/receipts/todomvc-edit-confirmation-2026-09-05.md)
compares TodoMVC's original double-click editor with a local keyboard-accessible Edit patch.
The [patch](fixtures/todomvc-visible-edit.patch) is the exact source change studied.
It modifies public TodoMVC source under its [MIT license](fixtures/todomvc-LICENSE.txt); the upstream notice is preserved beside the patch.
TodoMVC is a study subject, not a Humanish adopter or endorser.

These commands rebuild the app variants. The later sections describe how to author the
same-item measurement; they do not provide the study's complete private runner or a
turnkey replay of its twelve sessions.

## Rebuild two disposable app versions

From a Humanish checkout, use a separate directory for the subject:

```bash
export HUMANISH_STUDY_ROOT="$PWD"
git clone https://github.com/tastejs/todomvc.git /tmp/todomvc-edit-study
cd /tmp/todomvc-edit-study
git checkout --detach ff43b02e59dfa604386bb382034b2cd07c2bcd8a
npm --prefix examples/javascript-es6 ci --ignore-scripts
npm --prefix examples/javascript-es6 run build
```

Keep a copy of `examples/javascript-es6/dist/` as the original build. Then apply the patch:

```bash
git apply "$HUMANISH_STUDY_ROOT/bench/fixtures/todomvc-visible-edit.patch"
npm --prefix examples/javascript-es6 run build
```

Keep that `dist/` as the patched build. Preserve the upstream license with each copy.
The receipt pins the JavaScript and CSS hashes for both studied variants. Compare your
builds before asserting byte-equivalent reproduction; current build-tool environments
can differ even with the same source and npm lockfile. Do not push changes upstream.

The patch adds a visible native button and routes its click event into the existing
item-edit handler. Keyboard Enter activates a focused native button. It also adds an
editing-field accessible name, restores Edit focus after Enter/Escape, and changes the
footer instruction. The comparison evaluates all of those changes together.

## Declare the task and input modes

Use a fresh local-tree subject and hosted desktop per attempt. Package only the selected
build, its license, and the identical study instrumentation. A static subject can use:

```yaml
subject:
  source: local-tree
  serve:
    start: python3 -m http.server 3000 --bind 127.0.0.1 --directory app
    url: http://127.0.0.1:3000/
```

Here `app/` contains one retained build. This ordinary server does **not** provide the
state audit described below. Supply an instrumented server when using hidden app-state
criteria. Do not declare those criteria against an uninstrumented static page and assume
they were measured.

Keep this mission identical across both builds:

> You are trying this to-do app for the first time. Add one task named Draft proposal.
> Rename that same task to Send proposal and leave the renamed task saved in the list.
> Use the app's visible interface; do not open developer tools, run scripts, or edit page
> data directly. Report what you did and what happened, including anything that behaved
> differently from what you expected.

Use the same resolved synthetic persona and model in every condition. For pointer
participants, allow the mouse for controls and keyboard for text entry. For keyboard
participants, prohibit clicks, double-clicks, pointer motion, dragging, and mouse-wheel
input; tell them to report where they stopped if no keyboard path exists. Do not mention
the Edit button in either mission.

The recorded comparison used three repetitions per build/input mode, twelve attempts
total, with interleaved order, no replacements, a five-minute actor horizon, and natural
participant endings. Keep interrupted attempts visible. Do not combine mobile-emulated
sessions with desktop keyboard sessions; the [mobile conformance receipt](../docs/goals/computer-use-actor/receipts/mobile-input-conformance-2026-09-05.md)
explains the held touch comparison.

## Observe the same item without teaching the participant the answer

The saved-state check needs a subject-specific observer, not a search for the new title.
Use a read-only browser instrument that records:

1. Each `.todo-list > li` row's `data-id`, an allowlisted title, and edit-mode presence.
2. The first nonediting row with the original title, retaining its ID.
3. A fresh final snapshot showing that ID with the new title and no active editor.

A serialized snapshot queue and fresh request/acknowledgment barrier prevent a stale
success from satisfying a later observation. Reject ambiguous original rows. Invalidate
continuity on a reload or a new page epoch; this version's todo storage is in memory.
Do not read the edit input's value as proof that the change was saved.

Use the public `runLab` → `cuaHooks.runSession` seam to wrap the default
`createE2BDesktopExecutor` observer and call `runCuaActorSession`. Preserve the original
screenshots, browser probe, action executor, provider settings, budgets, and callbacks.
Add only evaluator-side state, for example:

```yaml
tasks:
  - id: rename-same-item
    goal: Rename the original item and leave it saved.
    success:
      any:
        - appStatePathEquals:
            path: todomvcStudy.sameIdRenamed
            equals: true
```

The path above is supplied by your observer; Humanish does not create this TodoMVC field.
Capture the final audit before desktop teardown. Check that state fields never enter
participant requests. Require a final fresh observation in addition to the historical
task funnel: a task can complete and then be undone. Keyboard success also requires zero
participant pointer actions.

Before paid runs, prove the observer rejects delete/recreate, an unsaved edit, a wrong
item, stale snapshots, ambiguous originals, and reloads. A missing observer must produce
unmeasured data. Retain these controls separately from actual participant results.

## Bound costs and inspect the result

The recorded study used published Humanish `0.81.0`, `gpt-5.6-sol`, a $1.50 running model
cap, 4,096 maximum output tokens per request through a study-only provider wrapper,
and a 15-minute sandbox TTL. A running model cap is checked after responses; reserve
for the final response and desktop lifetime as well. Those wrapper limits are not an
ordinary lab-manifest setting in `0.81.0`. Verify current pricing and measure each
sandbox's CPU/RAM allocation instead of treating the default estimate as a receipt.

Use only synthetic data and capture reviewed, readable frames if visual evidence is
needed. The recorded study's screenshot redaction produced 96 × 63 pixel frames;
those could not corroborate title text. Its live conclusion rests on state audits,
action traces, and participant reports.

Run `humanish verify` and render feedback drafts locally. Check the participant's account
against the state and actions before sharing a finding. Preserve every attempt and
cleanup receipt, and report provider interruptions separately from app-level blockers.
