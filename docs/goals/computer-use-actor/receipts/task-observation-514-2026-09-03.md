# The task funnel was blind on every non-Node subject: the DevTools probe needed an interpreter the desktop did not have

Date: 2026-09-03. Same lab, same two public pricing pages, run twice: once on the published
0.74.0 from a cold `npm i -D humanish@0.74.0 @e2b/desktop` in a temp dir, once on this branch.
Lab: `subject.source: app-url`, `policies.allowPublicTargets: true`, two lanes with per-lane
`target`s (`https://vercel.com/pricing`, `https://stripe.com/pricing`), one persona, and two
declared tasks: `reach-prices` (`urlIncludes: pricing`, true from the first observation) and
`read-a-price` (`textIncludes: "Pro"` or `"2.9%"`). This is the shape #514 was filed from.

## Result

| run | build | reach-prices | read-a-price | stream.viewport | geometry source |
|---|---|---|---|---|---|
| `cua-2026-09-03T21-05-07-027Z-4ccaec8a` | 0.74.0 | never measured in 2 | never measured in 2 | omitted, both lanes | xdotool |
| `cua-2026-09-03T21-03-34-130Z-1d4856ea` | this branch | 2/2, both at turn 0 | 2/2, both at turn 0 | 1440x863 dpr 1, both lanes | cdp |

Each run cost about $0.03 (two desktops for about 3 sandbox-minutes). In each run one
participant finished and the other ran out its 150 s budget reading; that varied by lane between
the two runs and is participant behaviour, not the harness.

## Root cause

Every url, page-text and CSS-viewport observation ran `node --input-type=module -e ...` inside
the sandbox. The stock E2B desktop template has python3 and curl and no Node; Node arrives only
when a subject's serve pipeline asks for it (`subject-runtime.ts`, #371). So on the app-url route
there is never a Node, and on any subject served by something else (the taskly benchmark arms are
`python3 -m http.server`) there is never a Node either. The probe exited 127 on every turn, the
executor swallowed the exit code into `{}`, `stopObservationOf` dropped the absent `url`, and the
tracker evaluated nothing. The only trace was the geometry warning "Browser CSS viewport could not
be measured", which named the symptom and not the cause. Nineteen kept run bundles from
2026-09-01 carry that exact warning (the taskly benchmark arms and the TodoMVC persona-contrast
runs). None of those labs declared tasks or `stopWhen`, so nothing was lost there; a lab that had
would have read 0/N.

The tab-pinning fix that preceded this one (prefer the active target) was diagnosed on a drawDB
clone, where `npm install` had brought Node with it and the probe happened to work.

## What changed

- `src/chrome-cdp-probe.ts`: the probe is one python3 stdlib script (urllib for `/json`, a
  hand-rolled WebSocket client for `Runtime.evaluate`, no Origin header, no proxy handlers). It
  prints `{"unavailable": "<reason>"}` on failure instead of `{}`.
- `makeChromeBrowserStateObserver` reports a dark channel once per lane through `onUnavailable`;
  the lane records "Browser-state observer unavailable for lane X (reason); urlIncludes /
  urlPathEquals / textIncludes stop conditions and task criteria are NOT being measured this
  session." The geometry warning now carries the probe's reason as well.
- `tests/chrome-cdp-probe.test.ts` runs the shipped script under the real python3 against a real
  headless Chrome: port resolution (cached, marker re-read, garbled marker, legacy 9222), state
  and geometry reads, pinned-versus-active selection, the shell-quoted command end to end, and
  the exit-127 path that was the defect.

## Not verified

- A desktop template with neither python3 nor Node: the lane warning is the designed behaviour
  and is unit-tested, not exercised live.
- The 09-01 benchmark numbers were read from the participants' reports and declared no task
  criteria, so they do not change; this was checked by grepping the 19 bundles, not by rerunning.
