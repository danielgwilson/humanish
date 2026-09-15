# Study review polish verification — 2026-09-15

Scope: retained study cost accounting, representative finding captures, report
qualifications, and final hosted Chrome viewport readback. Release candidate:
`humanish@0.91.1`, source `6e4e4e5`, based on `993787c`.

Generated bundles, provider identifiers, transcripts and screenshots remain
outside the public source tree. This receipt records methods, results and limits.
Public fixtures use fictional products and sanitized provider replies.

## Local release and browser gates

| Gate | Result |
| --- | --- |
| `pnpm release:check` | Passed: 2,942 core tests, 10 explicitly skipped tests, 63 TUI tests, typechecks, builds, compiled CLI checks, TUI smoke, public scan, skill discovery and npm dry pack. |
| Site typecheck, build and `registry:check` | Passed. |
| `pnpm docs:check` | Passed; generated reference covers 44 commands. |
| Observer tests | 292 passed. |
| `pnpm observer:browser:proof` | 55 cases passed, including desktop and phone report review, evidence navigation, focus restoration and playback scrubber geometry. |
| `pnpm observer:iframe:proof` | 15 isolation assertions passed. |
| Final build, public-surface scan and `git diff --check` | Passed. |

The full local release gate preceded the last touch-hover and browser-proof
readiness patch. The final build, all Observer tests, all 55 browser cases,
iframe proof and public scan ran afterward. CI reruns the full release gate on
the submitted commit.

## Cost accounting

An independent code review accepted the accounting change after exercising
96 focused tests. Checks cover distinct attempts, reuse, interrupted dispatch,
legacy or incomplete history, stale analysis, malformed receipts and directory
identity conflicts. A retained-history audit independently reconciled participant
and desktop estimates plus five distinct analysis attempts to the new totals.

Existing stats fields retain their participant-and-desktop meanings. New cost
fields are additive. Unknown prices or histories remain explicit; statistics do
not initiate analysis. See the [cost contract](../../../contracts/study-costs.md).

## Installed candidate with actual analysis

The candidate tarball contained 451 files. SHA-256:
`1fe4c3d93b736a2689b7c6a7d3fb61f8ea0dd76aff12e97c8392be0f386349f2`.
A fresh consumer installed that tarball and `@e2b/desktop@2.4.0`. All 451
installed file hashes matched the packed payload; the built Observer artifact
used for browser proof matched the packed artifact.

Retained run: `scripted-2026-09-15T21-17-59-128Z-8ce78ef5`.

1. Four actual hosted browser steps exercised a fictional note-taking app.
   The lab omitted `review.analysis`, exercising automatic analysis by default.
2. Automatic analysis completed with one priced attempt: $0.239617.
3. Reusing the saved analysis retained its identity and added no spend.
4. An explicit rerun issued a second request with a distinct identity. The
   independently summed execution receipts and stats agreed on $0.388848
   across two attempts.
5. Stats, reuse, verification and HTML export ran in subprocesses without
   provider credentials and with network access denied and audited. They
   attempted no network requests.
6. Source run metadata, actor trace, events, browser trace and screenshot hashes
   were unchanged. The exported report opened in a real browser; cited evidence
   navigation worked on desktop and at 390 CSS pixels without horizontal overflow.

This scripted route has no run-cost estimate: `runEstimatedUsd` remained null
and `incompleteRunEstimates` remained 1. The $0.388848 figure is retained analysis
spend, not complete billing. This check does not establish autonomous participant
behavior or general finding accuracy.

## Finding previews and readable caveats

The selected preview now prefers directly cited visual evidence over inherited
context. Distinct visual/action claims resolve ties deterministically; duplicate
citations do not inflate the count, and an explicit lead remains authoritative.
A retained case changed from an early setup capture to its cited conflict state;
the preview opened the original frame and returned to the finding. Saved analysis,
review corrections and participant feedback were unchanged.

Confidence, recovery and the first original limitation remain visible. A
disclosure exposes the remaining unique limitations, with observation-specific
details still accessible. Desktop and phone checks exercised long caveats,
long participant labels, exact evidence links and keyboard focus.

Independent visual review requested revisions for a clipped focus outline and
an inadequately settled source screenshot. The final 11-image review accepted
the result. Capture readiness now waits for the intended image, decode, visible
geometry and paint; a retained premature blank capture failed all eight source
pixel checks while the settled capture passed all eight. Touch-only devices no
longer retain citation hover styling after navigation.

Preview selection remains a citation heuristic, not a guarantee of the most
informative image. Existing citation ordering and long-label wrapping remain
possible follow-up improvements.

## Actual hosted Chrome geometry

Synthetic loopback pages on the stock E2B desktop template exercised a foreground
tab, a redirect in the background launch tab, and closure of the launch tab.
The captured SDK/CDP replies reported outer bounds 0×0 and CSS dimensions
1512×805 for the background page; the foreground page reported 1512×861.
After launch-tab closure, a pinned read was unavailable.

The candidate's `captureDesktopBrowserGeometry` measured the active page at
1512×861 after both transitions, without a CSS-readback warning. Launch
measurement remained pinned. Valid CSS and outer-window measurements are
validated independently; unusable CSS stays missing and never falls back to
physical screen dimensions.

The committed `tests/fixtures/chrome-cdp/hosted-geometry-2026-09-15.json` derives
from an actual hosted SDK reply, including stdout and raw CDP result nesting.
Page identifiers were replaced with neutral labels. Negative tests explicitly
corrupt this captured input. The three new regression cases failed against
`993787c` and passed against the candidate; 239 focused tests passed.

Five owned probes were reclaimed and exact-ID absence confirmed. One initial
Chrome-readiness failure and one incomplete tab-closure diagnostic were retained
as unsuccessful attempts. No model requests were made. The probes do not prove
physical mobile fidelity, browser zoom behavior or multiple focused windows.

## First-contact release dogfood and cleanup

`pnpm release:dogfood` passed using an independently operated terminal lane and
the installed candidate. Retained run:
`terminal-2026-09-15T21-18-07-100Z-5bcb7884`.

The participant confirmed the version, generated and verified a free preview,
created feedback and an HTML export, opened Observer, and completed the bundled
deterministic example. It stopped at the deliberately withheld live-provider
credentials, satisfying the release gate's expected boundary behavior. This is
not a credentialed autonomous desktop-study proof.

The participant again noted that metadata-only preflight wording could suggest
more readiness than it establishes. The own-app guide now directs users to the
hosted reachability check and discloses its desktop cost; runtime preflight
wording remains a follow-up. Dogfood provider tokens were measured but unpriced,
and its other unmeasured cost lines stayed null. A zero known subtotal is not a
claim of a free run.

The installed-candidate and terminal-dogfood sandboxes were both confirmed
absent after their owning producers completed. Separate read-only checks
confirmed exact-ID absence again. No account-wide cleanup was performed and
persisted identifiers did not authorize additional kill calls.
