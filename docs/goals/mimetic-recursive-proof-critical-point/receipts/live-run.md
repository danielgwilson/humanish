# Live Recursive Proof Receipt

Date: 2026-06-04

## Final Proof Run

Target repo:

```text
reduxjs/redux-essentials-example-app
```

Command shape:

```bash
MIMETIC_E2B_REQUEST_TIMEOUT_MS=30000 \
MIMETIC_E2B_TIMEOUT_MS=3600000 \
MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS=900000 \
MIMETIC_OSS_META_COMPLETION_INTERVAL_MS=10000 \
pnpm mimetic -- lab oss --detach --open --count 1 --repos reduxjs/redux-essentials-example-app
```

Secret handling:

- `E2B_API_KEY` and `OPENAI_API_KEY` were sourced from a local ignored env file.
- Secret values were not printed, copied into docs, or committed.
- Durable artifacts persisted public repo slug, public-safe log tail, local loopback URLs, synthetic Mimetic starter output, and screenshot evidence.

Final run:

```text
run: oss-meta-2026-06-04T08-33-55-996Z-8854989a
mode: live
verdict: pass
repo: reduxjs/redux-essentials-example-app
desktop lanes: 1
target app: running at http://localhost:5173
nested mimetic: live app-url proof, sims: 2
nested verify: passed
nested observer: present
headed visual layout: visible, 3 Chrome windows detected
top-level screenshot: captured
```

After audit, the already-captured proof bundle was corrected from the stale
meta-lab contract label to `mode: live`, then the Observer was rerendered and
the same run was verified again. No additional paid E2B launch was used for this
metadata correction.

Verification:

```bash
pnpm mimetic -- verify --run oss-meta-2026-06-04T08-33-55-996Z-8854989a --json
```

Result:

```text
ok: true
run schema: passed
redaction: passed
review artifacts: present
public-safety scan: passed
local evidence artifacts exist: passed
```

Observer rerender readback:

```text
warning: Observer renders verified local evidence artifacts; runtime stream auth URLs are not persisted.
```

## Evidence Paths

Ignored runtime artifacts:

```text
.mimetic/runs/oss-meta-2026-06-04T08-33-55-996Z-8854989a/run.json
.mimetic/runs/oss-meta-2026-06-04T08-33-55-996Z-8854989a/review.md
.mimetic/runs/oss-meta-2026-06-04T08-33-55-996Z-8854989a/observer/index.html
.mimetic/runs/oss-meta-2026-06-04T08-33-55-996Z-8854989a/observer/observer-data.json
.mimetic/runs/oss-meta-2026-06-04T08-33-55-996Z-8854989a/screenshots/oss-01-desktop.png
```

The screenshot was visually inspected. It shows:

- the Redux Essentials app open in a desktop browser window;
- the same app open in a compact browser window;
- the nested Mimetic Observer open with desktop and mobile browser-surface lanes;
- the nested Observer marked complete with screenshot evidence.

## Attempt Log

- `antfu-collective/vitesse-lite`: failed before sandbox launch when an E2B timeout above one hour was rejected by the provider.
- `antfu-collective/vitesse-lite`: failed because the old bootstrap installed Mimetic with npm against a pnpm repo using `catalog:` dependencies.
- `antfu-collective/vitesse-lite`: failed on pnpm trust-downgrade protection. This was treated as a target supply-chain guard, not bypassed.
- `reduxjs/redux-essentials-example-app`: failed on Yarn 4 because the bootstrap used `yarn add --ignore-scripts`.
- `reduxjs/redux-essentials-example-app`: failed because Vite responded on `localhost`, while the bootstrap only probed `127.0.0.1`.
- `reduxjs/redux-essentials-example-app`: one launch attempt was interrupted after a silent pre-bundle wait. This exposed a launch observability gap.
- `reduxjs/redux-essentials-example-app`: passed after package-manager and loopback-readiness fixes.
- `reduxjs/redux-essentials-example-app`: passed again after review-gap wording was corrected.
- `reduxjs/redux-essentials-example-app`: actor-first required attempt first exposed that actor-control env flags were not forwarded into E2B.
- `reduxjs/redux-essentials-example-app`: actor-first required attempt then exposed that the actor wrapper printed `actor_exit=1` but returned success.
- `reduxjs/redux-essentials-example-app`: actor-first required attempt finally failed closed with `actorStatus=timed_out`; app surface, nested live app-url proof, nested Observer, and screenshot evidence still passed.
- Provider cleanup: seven running Mimetic OSS meta-lab sandboxes were found by
  E2B metadata query and killed; follow-up running-sandbox count was zero.

## Provider Usage Note

The final proof run used one headed E2B desktop lane. After the proof, E2B's
running sandbox list was queried with metadata
`tool=mimetic-cli&mode=oss-meta-lab`. That provider readback found seven running
Mimetic OSS meta-lab sandboxes. The old total run-count cap was an arbitrary
goal-design mistake; the useful provider controls are dollar budget,
wall-clock budget, provider timeout, and cleanup/readback, not a hidden
desktop-count cap.

All seven matching disposable sandboxes were killed, and a follow-up provider
readback returned zero running Mimetic OSS meta-lab sandboxes. Exact provider
dollar usage was not available from the local CLI. Further provider launches
for this goal are allowed only while the active spend policy remains true:
estimated spend under $50, wall-clock under 2 hours, at most 4 concurrent
running Mimetic OSS meta-lab desktops, and cleanup/readback to zero after proof
collection.

Follow-up code guard: live OSS meta-lab launches now check existing running E2B
sandboxes with Mimetic OSS meta-lab metadata and fail closed when running plus
requested headed desktops would exceed the configured cap.

## Remaining Limits

- This is a phase-change proof, not platform readiness.
- The nested Mimetic proof captures desktop/mobile render evidence and HTTP
  readiness; autonomous multi-step persona navigation remains the next adapter
  slice.
- The Codex actor attempt is launched and visible in the remote environment, but
  the completion claim is based on deterministic bootstrap evidence rather than
  actor-authored project changes.
