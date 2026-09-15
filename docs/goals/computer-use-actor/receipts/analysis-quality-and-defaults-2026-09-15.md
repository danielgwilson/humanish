# Analysis concerns, evidence selection and automatic defaults

Date: 2026-09-15. Candidate version: `0.91.0`.

This work addresses [#780](https://github.com/danielgwilson/humanish/issues/780)
and [#781](https://github.com/danielgwilson/humanish/issues/781). The original
recording described in #780 was not available in this workspace. The cases below
are neutral authored reconstructions and a separate fictional browser study;
they are not a replay or reproduction of that recording.

## Interpretation comparison

The [retained challenge protocol](../../../../fixtures/analysis-quality/README.md)
defines four scripted reconstructions: repeated identity/setup uncertainty,
recovered selection with a separate submission blocker, intentional sparse data
with a successful local save, and a misread label with an unsubmitted draft.
Five authored participant paths provide thirteen actual rendered PNGs. Source
bytes, prospective expectations and selected packets were frozen before model
responses. A clarification of an initially loose outcome allowlist was recorded
before inspecting the affected responses; the original expectation was retained.

Published `0.90.0` (`study-evidence-4`) and compiled candidate `a834210`
(`study-evidence-5`) each made one real `gpt-6-astra`/high request per case.
All eight first responses validated and were retained, without retries or edited
results. The selected packets were byte-identical and complete, so this comparison
isolates the prompt and response-contract changes. It does not evaluate the new
sampler under pressure. Known token-derived estimates totaled **$2.052040**;
the local admission reservations totaled $24 against a $25 allowance. Estimates
are not provider invoices or enforced billing caps.

Both versions retained all three required concerns, preserved affected/exposed
participant membership and recovery distinctions, ranked the blocker above the
recovered detour, and avoided the negative-control defects. An independent review
of all result fields found no critical or material factual errors. One minor
baseline source-citation precision issue remained.

The candidate exposed eight evidence-linked concern decisions: five linked to
findings, one retained as context and two excluded as unsupported. The baseline
already passed these designed cases. This demonstrates inspectable concern
accounting and bounded nonregression; it **does not demonstrate improved recall**,
reproduce the original miss, or estimate reliability across live participants.
The reviewer was independent of the production prompt author, but this was not
a blind held-out evaluation or a study of human behavior.

## Evidence selection

Selection tests retain original event/frame identities while exercising long and
short participants, late failed actions and following captures, missing files,
invalid PNGs, unavailable assignments, UTF-8 text limits and legacy histories.
Count, text and image reservations give participants an initial opportunity;
unused image/read reservations subsequently become available to other lanes.
This includes a valid roughly 3 MiB PNG across sixteen lanes, where a fixed
per-lane byte quota would otherwise reject it despite unused global capacity.

The default bounds remain sixteen participants, 800 evidence entries, forty
captures, 160 KiB of selected text, 8 MiB per image and 20 MiB of admitted images.
At most eighty contained file attempts return at most 40 MiB of buffers,
including invalid images. A file that changes during a read may consume bytes
and be rejected; physical I/O is bounded by attempts and per-read limits, not
by the returned-buffer limit. Missing or rejected captures and other coverage
limits stay visible. Sampling cannot guarantee discovery of every issue.

## Actual automatic browser flow

An earlier packed candidate at `34b8970` was installed in a fresh consumer and
ran one scripted browser participant against the fictional Trail Notes app on a
hosted desktop. The manifest omitted `review.analysis` entirely. The browser
actually loaded, entered text, saved, and inspected the empty saved-notes list
despite confirmation copy. Four original captures and the assignment were
retained. The app lived outside a read-only public scaffold checkout pinned to
`octocat/Hello-World@7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`.

The completed recording triggered one analysis, with one qualified finding and
two concern reviews. The analysis left the requested outcome unknown; visible
confirmation did not establish persistence. Its admission estimate was $1.198963
and known usage estimate **$0.202493**. Opening, reading, verifying and exporting
the recording did not dispatch another request or change original source bytes.
Desktop and phone checks exercised exact evidence links, keyboard return,
reload and overflow. The owned sandbox was confirmed absent by its exact ID.

That first package preceded the final selector and startup-eligibility fixes.
Its successful result is retained separately from the final-package retest.
This is actual browser and provider execution with a deterministic scripted
participant, not an autonomous participant study or evidence of population recall.

## Release verification

Reviewed source `77fe9b5` produced a 446-file `0.91.0` package with SHA-256
`598db52e3cd33bbebe8dcfa8dee900daf931d288582133f2fac275a43f8a141d`.
The complete per-file manifest is retained with the private proof artifacts.

`pnpm release:check` passed: 2,918 core tests (ten explicitly skipped), 63 TUI
tests, typechecks, builds, compiled startup/preflight checks, TUI smoke,
public-surface scan, skill discovery and package inspection. Separately, 289
Observer tests, all 53 browser cases, fifteen iframe-isolation checks, the site
typecheck/build/registry check, and the 44-command generated-doc check passed.
The final package's Observer artifact matches the browser-tested artifact hash.

The compiled startup proof caught an unwanted default request after desktop
startup failed. A second independent review found that launcher stderr could
masquerade as terminal engagement. The final guard requires recognized retained
runtime items for terminal defaults. Seven producer/coordinator cases now cover
request-free launcher failures, meaningful command/message output, split stdout,
early activity outside the display tail and permanent claims. Their request
boundary is injected and rejects locally; they do not claim provider execution.
Explicit diagnostic analysis remains available. Positive retained reasoning-item
wire coverage was unavailable and is not claimed.

The final-package browser retest and first-contact release study are separate
operational gates; the earlier browser result above does not substitute for them.
