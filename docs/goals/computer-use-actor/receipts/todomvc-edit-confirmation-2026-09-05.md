# A local TodoMVC Edit patch enabled keyboard rename

Date: 2026-09-05. Humanish `0.81.0`, installed `@e2b/desktop` `2.3.3`,
`gpt-5.6-sol`. Twelve new independent hosted attempts on
[`tastejs/todomvc` JavaScript ES6 at `ff43b02e`](https://github.com/tastejs/todomvc/tree/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/javascript-es6).
TodoMVC is a public study subject, not an adopter or endorser. Only a disposable local
copy was changed; no upstream mutation was performed.

## Finding, patch, repeated comparison

Keyboard-only participants could add a task but could not activate the original
label's double-click edit handler. Tab reached completion controls and filters rather
than an editor. That agrees with the pinned source and a local browser control.

The [public patch](../../../../bench/fixtures/todomvc-visible-edit.patch) adds a native
Edit button beside each task, associates it with the task label, names the editing
field, restores focus after Enter/Escape, adjusts label spacing, and updates the footer
instruction. Double-click editing remains. The experiment evaluates this whole patch;
it does not isolate the button, focus handling, or instructional text individually.

The mission was identical across conditions: add “Draft proposal,” rename that same
item to “Send proposal,” and leave it saved. It named neither the Edit control nor the
scoring fields. Pointer participants used the mouse for navigation and the keyboard
for text. Keyboard-only participants were instructed never to switch to a pointer.
Each used the same resolved `synthetic-new-user` persona on a fresh desktop.

## All twelve attempts

| Version / mode | Repeat 1 | Repeat 2 | Repeat 3 | Rename completed / attempted |
| --- | --- | --- | --- | --- |
| Original / pointer | Completed | Completed | Completed | 3/3 |
| Edit patch / pointer | Completed | Completed | Completed | 3/3 |
| Original / keyboard-only | Provider interrupted | Blocked | Blocked | 0/3 |
| Edit patch / keyboard-only | Completed | Provider interrupted | Completed | 2/3 |

Among uninterrupted keyboard sessions, the comparison is **0/2 versus 2/2**.
Both original participants stopped with the original title saved. Both patched
participants reached Edit with Tab, activated it with Enter, selected the text,
and saved the new title. No keyboard participant used a pointer action.

One earlier setup attempt ended before a participant outcome and is retained separately.
It is not included among these twelve new attempts. No attempt was replaced. Six mobile
cells remained unrun after the [input-conformance diagnostic](mobile-input-conformance-2026-09-05.md);
there is no physical-mobile or touch-device conclusion.

## The completion check preserves item identity

An identical read-only browser instrument in both app versions observed each todo row's
`data-id`, an allowlisted title, and whether editing was active. It never changed the
DOM, storage, focus, or participant input. A per-observation request/acknowledgment barrier
required a fresh browser snapshot. A page reload changed the instrument epoch and
invalidated continuity instead of rebinding an item ID.

The initial checkpoint required an observed nonediting “Draft proposal” row. Success
required that **same ID** to carry “Send proposal” outside edit mode at the final fresh
observation. A previously completed Humanish task checkpoint alone was insufficient,
because those checkpoints retain historical completion. A delete/recreate workaround
or an unsaved input could not satisfy this endpoint.

All twelve final audits were available. All eight completions preserved the original
item identity. The two provider-interrupted attempts remained incomplete observations
of the task, not app failures. The state fields were provided only to the evaluator;
a captured request-shape control confirmed they were absent from the model request.

The private study adapter used the public `runLab`, `runCuaActorSession`, and
`createE2BDesktopExecutor` seams. It captured the audit before the parent lab reclaimed
the desktop. [The authoring recipe](../../../../bench/todomvc-edit-study.md) explains
which parts are reusable and which need a subject-specific state observer.

## Registration and controls

The source files, actual persona, mission, model, and interleaved condition order were
frozen before the new cohort. Three repetitions per version/input condition were
planned; at most two desktops ran concurrently with at least 42 seconds between starts.

Each actor had a 300-second timeout and a $1.50 running model cap. A study-only provider
wrapper limited responses to 4,096 output tokens, at most 32 requests, and a conservative
220,000-token estimate of request input. This estimate used previous response usage,
new text bytes, and screenshot/tool overhead; it was not a provider-enforced input
limit. The wrapper disabled provider retries. Sandboxes had an explicit 15-minute TTL.
These limits were identical across conditions.

After five attempts, a provider transport failure stopped scheduling. All five desktops
were reclaimed. An accounting-only correction made response-body read/decode failures
explicitly unknown, and seven never-started attempts resumed in the original order.
The original and corrected wrapper versions, initial results, and both logs are retained.
The task, app patch, model settings, and request limits were unchanged.

Local controls passed before allocation: eight audit tests, six real-browser/public-API
checks, twelve dry configurations, and two real local-tree packing checks that stopped
before the injected provider boundary. Audit cases included wrong labels, delete/recreate,
unsaved edits, duplicate originals, stale barriers, invalid payloads, and reloads.
A separate local subject control verified original pointer editing and patched keyboard
editing. Its first scripted Tab-count assumption was incorrect; the corrected control
followed the actual focus sequence. Neither local control used a model participant.

The rebuilt subject artifacts were pinned before instrumentation:

| Artifact | Original SHA-256 | Edit patch SHA-256 |
| --- | --- | --- |
| JavaScript bundle | `01b56caf970328499b1ea12a405bd4c03e27bc4bad6d6e36d49884fe75159fac` | `0803d67a040e8b09630fba8746d52d54c2c4ae2b9378123d09b707fce29448be` |
| CSS | `399c4f5ba333eabe3cd3fa4ea6c7093dc0a9440aa32ed90d71d7df485069c6c1` | `5faa8bdf20d24c343bc4d380651cd115477bc425f6f102a529c75c2f52e4779e` |

The source patch SHA-256 is
`58b1fa63461e3c47839a4cdad265f8fd54a73617acce0f823ff362b5af64e012`.
Full study bundles remain operator-held; per-condition repetition labels map to those
retained bundles. No provider identifiers or raw hosted bundles are published here.

## What remains uncertain

This is a descriptive, same-model synthetic comparison on one pinned app. It does not
estimate human success rates or statistical efficacy. Pointer completion did not improve:
both versions were 3/3. Successful participants still reported unclear row focus and
manual title selection, so an overall reduction in reported friction was not established.
The pinned runtime had a known repeated-click movement wait; no speed claim follows.

The frozen screenshot policy reduced every retained live frame to **96 × 63 pixels**.
They are too blurred to read the todo title. The usable live evidence is the fresh state
audit and action trace, supported by participant reports and source controls. Local
full-resolution controls are not participant screenshots. All twelve bundles verified
as `share_ready`, and nine emitted feedback candidates rendered local drafts; neither
result certifies screenshot legibility or candidate correctness. No draft was posted.

Every normal teardown reported success, and separate exact-allocation lookups confirmed
all twelve desktops absent. E2B reported 8 vCPU and 8 GiB per desktop, rather than the
2 vCPU/4 GiB placeholder in the pinned Humanish estimate. Using the measured resource
shape and current official rates, known model usage plus a conservative desktop lifetime
estimate was about $0.77. Two of 68 requests lack usage receipts, so total cost remains
unknown. No provider invoice total is claimed.
