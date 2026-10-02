# Goal: make `actors[].type` a real dispatch key (computer-use lab)

Status: shipped (0.4.0).

## What

`humanish.lab.v2` configs with `subject.source: app-url` now dispatch end-to-end:

- `actors[0].type` is resolved against the **actor registry** at parse time and at the engine
  (fail closed both places); the resolved `CuaActorDescriptor.runSession` runs the session.
  The registry contract is explicit: lane `computer-use` ⇒ a CUA-shaped descriptor
  (`isCuaActorDescriptor`), which is what lets the lab dispatch on capabilities rather than
  on hardcoded actor ids.
- `selectLabBackend` routes the new pairing (`app-url` × `e2b-desktop`) to a fourth backend,
  `runCuaActorLab`, leaving synthetic/smoke/meta byte-for-byte untouched. The two axes stay
  orthogonal: subject × execution selects the substrate; `actors[0].type` selects which
  registered actor runs inside it.
- The lab fills the previously-declared-but-unfilled `RunStream.actor` seam with the loop's
  `humanish.actor-trace.v1`, persists a full run bundle (`run.json` / `review.*` /
  `events.ndjson` / `actor.json` / `screenshots/`), and renders the existing Observer with
  zero Observer changes.
- Consumed config fields on this route (and de-warned accordingly):
  `actors[0].{type,mission,persona,laneFocus.instruction,model}`, `subject.appUrl`,
  `execution.timeoutMs`, `execution.desktop.{resolution,sandboxTimeoutMs}`. Other routes keep
  their honest forward-declared warnings.

## Public-safety stance

- `subject.appUrl` is **loopback-only at entry** (parse-time rejection of public targets,
  re-enforced at the engine for library callers). The constraint binds the entry URL; a
  navigation watchdog for mid-session escapes inside the sandbox browser is a later slice.
- **No env vars are forwarded into the sandbox** — the model drives the desktop from outside
  via the provider API; no key ever exists inside the sandbox.
- The live stream URL (carries an auth key) is runtime-only and never persisted; bundles
  record only its presence. `bundle.cwd` persists as the public label, never an absolute path.
- Evidence is redacted at the loop boundary (blurred screenshots, `type [N chars]`); the
  bundle passes `verifyRun`'s public-safety scan in the deterministic suite.
- Spend-safe default: app-url labs run dry-run (contract bundle) unless `scenario.mode: live`.

## Honest gaps (deliberate)

- The lab does not serve the subject app: `appUrl` must be reachable from inside the sandbox.
  Library callers provision it via the documented `prepareDesktop` hook (`cuaHooks`); a CLI
  config alone can only target something already reachable. clone+serve is the next slice.
- Single lane only (`actors[0].count` must be 1); multi-lane fan-out is rejected, not ignored.
- The fail-closed safety-check default is unchanged; no auto-ack policy ships.

## Proof

- Deterministic: routing tests (all four backends), full dispatch-with-fakes test driving the
  REAL loop/provider/executor through `runLab` (asserts actuation, prompt composition from
  config, metadata/resolution/no-envs provisioning, teardown on success AND on session error,
  the filled `stream.actor` seam, evidence-on-disk equality, and that neither keys nor the
  stream URL appear in any persisted artifact), parse-time fail-closed matrix, zero-warning
  consumption proof on the cua route.
- Live (spend-gated, `HUMANISH_LIVE_CUA=1` + both keys): `tests/cua-actor-lab.live.test.ts`
  dispatches a real config through `runLab` to a real E2B desktop with the subject served from
  loopback inside the sandbox via `prepareDesktop`.
