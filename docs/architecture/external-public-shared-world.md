# External-public shared world and the lobby-code handoff

The shared-world route has two plane classes. This note documents the new
`external-public` class and the host-first handoff barrier that makes cross-persona coordination on a
real public app possible without any persona-to-persona messaging.

## The two plane classes side by side

|                     | provisioned-getHost (historical)                                     | external-public (new)                                                                             |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Shared plane        | a `clone`/`local-tree` subject served + `getHost`-exposed in-sandbox | a real operator-owned public deployment (`source: app-url`) used directly                         |
| Harness role        | Minted and controls the host URL                                     | Observes that the participants converged on one origin (tolerant of a declared→observed redirect) |
| Subject sandbox     | one (headless service host) + N actor desktops                       | none; only N actor desktops                                                                       |
| Attestation         | `subject.exposure: synthetic` (synthetic seeded data)                | `subject.publicTarget: { owner, authorized }` (you own/operate it)                                |
| Provenance          | `subject.state.provenance == seeded`                                 | `subject.state.provenance == external-public`                                                     |
| Plane identity      | `plane.hostDigest`; every `routeHostDigest == it` (harness-minted)   | `plane.publicOriginDigest`; every CDP-observed `routeHostDigest == it` (observed)                 |
| Shared-state proof  | authoritative in-sandbox checkpoint `stateSeries` + delta-on-pass    | none; `stateSeries` omitted (Option A)                                                            |
| Concurrency-on-pass | ≥2 overlapping windows and a state delta at/after an overlap start   | ≥2 overlapping windows only (temporal co-occupancy)                                               |
| Extra proof         | none                                                                 | `lobbyConvergenceDigest` (all participants on one `/lobby/CODE`)                                  |

The run's own verdict applies the same concurrency-on-pass rule per plane (`judgeSharedWorld` in
`src/run/judge.ts`), so a run whose participants all passed but missed it reads fail and the study exits
non-zero.

In short: getHost = harness-minted host + synthetic-seeded attestation + authoritative
in-sandbox checkpoint `stateSeries`. external-public = operator-attested public origin + no synthetic
claim + no authoritative shared-state proof (concurrency evidenced by temporal co-occupancy +
observed lobby-path convergence only). Every downgrade is asserted-absent by verify, never silently
dropped: `plane.exposure` must be absent (claiming synthetic on a real site is a lie),
`plane.hostDigest` must be absent, the `seeded`/`synthetic` attribution limits are forbidden, and the
external-public disclosure limits are required.

Why the getHost synthetic gate is deliberately not reachable from the app-url branch: that gate
(`concurrentSharedWorldValidationReason` in `src/study/validation.ts` requires `subject.exposure:
synthetic`, a `0.0.0.0` bind and no `keep`; verify's `getHostPlaneFindings` in
`src/verify/shared-world-concurrent.ts` then requires `plane.exposure == synthetic` and
`subject.state.provenance == seeded`) exists because a getHost URL is internet-reachable and
harness-owned; real data behind a harness-exposed URL is the hazard. A public site the harness
neither provisioned nor exposed has neither property, so the gate's hazard does not exist there. The
app-url branch is validated by `externalPublicSharedWorldValidationReason` (`src/study/validation.ts`)
and is reached before the getHost gate; a snapshot regression test pins the getHost path
byte-unchanged.

## The CDP lobby-code handoff barrier

Reading a participant's live URL mid-run is already implemented: `makeChromeBrowserStateObserver`
(`src/substrates/e2b/desktop-cdp.ts`) runs an in-sandbox python3 probe
(`src/substrates/e2b/cdp-probe.ts`) that resolves the participant's Chrome CDP port, selects the participant's
page, and sends `Runtime.evaluate({ url: location.href, title, text })` over the page's
`webSocketDebuggerUrl`. `createE2BDesktopExecutor` stamps `observation.url` from it every turn.
`CuaObservation.url` is runtime-only by contract (it drives `stopWhen`/progress but is never
persisted raw into the trace).

The route reads each participant's URL through one callback, `LoopTaps.onObservedUrl?(url)`,
invoked right after every `executor.observe()` (the initial observe and each loop observe) with
`observation.url`, threaded through `CuaActorSessionOptions` → `CuaParticipantDeps` → the concurrent
orchestrator. It adds no CDP code and needs no change to the lobby-trivia app. The CDP URL read is
unreliable on E2B desktops, so the host's code can also come from its narration or its screen
(step 2).

`onObservedUrl`, `onMessage` and `onScreenshot` are internal `LoopTaps`
(`src/actors/computer-use/loop/types.ts`): 0.109.0 removed them from `CuaLoopOptions`, and the
public `runComputerUseLoop` refuses them. The actor passes them through
`runComputerUseLoopWithTaps`. A library caller wraps the executor's `observe` (for `url` and
`screenshot`) or the provider's `nextTurn` (for `reasoning` and `message`).

Flow, a host-first barrier inside `runConcurrentSharedWorld`'s fan-out:

1. **Designated host.** Exactly one roster entry carries `host: true` (validated). Its mission = create
   the shared lobby; its browser opens `subject.appUrl`.
2. **Latch.** `LobbyHandoff` (`src/routes/shared-world/handoff.ts`) creates a private latch before
   fan-out. The first of three reads of the host participant resolves it: its `onObservedUrl` URL matching
   `/\/lobby\/([A-Z2-9]{6})(?:$|[/?#])/` (a locale prefix `/en/lobby/CODE` and a query/hash suffix
   are tolerated), a lobby code in its narration (`extractLobbyCodeFromNarration`), or a vision read
   of its screenshot (`readLobbyCodeFromFrame`). The vision reads are out-of-band OpenAI calls, at
   most 30 per participant, and are not counted against `caps.maxUsd`. The host keeps playing
   after resolving, so its window overlaps the followers'.
3. **Barrier.** Follower participants (`host` absent) do not compose a mission or open their target until
   the latch resolves or the handoff deadline passes. On resolve, code is threaded into each
   follower's mission (`…choose Join, enter lobby code {CODE}…`). It is not a raw URL navigation,
   because a direct `/lobby/CODE` visit does not auto-join a non-member (lobby-trivia's lobby page
   redirects unknown/non-member sessions home); the follower goes through the real Join flow.
4. **Convergence confirmation.** Each follower's own `onObservedUrl`, or a vision read of its own
   frame, confirms it reached `/lobby/CODE`; this observed convergence becomes the
   `lobbyConvergenceDigest`, the pass signal that the followers reached the lobby. An instruction to
   join does not set it. It is recorded only when every participant converged on one code.
5. **Fail-closed timeout.** If the host never yields a `/lobby/CODE` within the handoff deadline
   (`min(execution.timeoutMs, max(120 s, 40% of execution.timeoutMs))`; injectable in tests), the
   latch rejects; every follower fails closed without opening (no wasted turns against a codeless
   home page); the run returns `HUMANISH_SHARED_WORLD_HANDOFF_TIMEOUT` and the bundle
   records the host window + a handoff-failed outcome for followers. If the host participant ends without a
   code before the deadline, `releaseFollowersIfUnlatched` releases the followers at once and the
   run returns `HUMANISH_SHARED_WORLD_FAILED` with the host's reason. A host that
   reaches the lobby but whose followers fail to join is a normal per-participant non-pass (the
   concurrency-on-pass gate then simply won't see ≥2 overlap, and the verdict stays non-pass),
   not a whole-run abort.

> **Temporary shim.** This CDP URL-relay handoff reads the host's `/lobby/CODE` off its own browser
> and threads it into the follower missions.
> [An open issue](https://github.com/danielgwilson/humanish/issues/296) tracks replacing it with the
> [actor message bus](https://github.com/danielgwilson/humanish/issues/297), where the host sends an
> SMS or email invite link and the followers receive and tap it. The orchestrator then no longer
> relays the code out of band.

## Observed-origin convergence (not declared)

The convergence proof is about what the participants observed, not what was declared. `plane.publicOriginDigest`
is the sha256-16 of the one origin the participants' CDP-observed final URLs converged on; verify requires every
`laneWindow.routeHostDigest` to agree on it. A normal cross-origin redirect (apex→www, http→https;
lobby-trivia.example.test 307-redirects) makes the observed origin differ from the declared `subject.appUrl`, which
is expected and must never fail the run. So the declared origin is recorded separately as
`plane.declaredOriginDigest` for reference and is never asserted equal to the observed one. Operator
ownership rests on the `subject.publicTarget.authorized` attestation + the declared `appUrl`, not on
digest equality. Verify fails closed only when the participants did not converge on a single observed origin
(it then lists the distinct observed origin digests).

## Hygiene

The runtime `location.href` (and the 6-char code inside it) is never persisted raw: `onObservedUrl` is
runtime-only; the threaded code flows only into the follower's composed prompt (never a raw bundle
field) and is scrubbed from all narration once latched; the shared origin and lobby path persist only
as sha256-16 digests (`publicOriginDigest`, `lobbyConvergenceDigest`). This matches the existing
e2b-URL / host-digest redaction discipline.

## Mobile fidelity caveat

The example roster runs mobile-layout participants (`device: mobile` 414×896, `small-mobile` 360×740). On
the E2B-desktop route the rendered width is floored to `MIN_DESKTOP_RENDER_WIDTH` (500) because
Chrome refuses a narrower window and a narrower X screen clips the page, so both
presets render at 500 wide and are identical in layout; only height renders as declared.
`desktopGeometry.screen.verified` compares the floored number with itself, so it does not attest the
preset width. There is no touch input, and `isMobile`/DPR are prompt-signal + metadata (DPR renders
only via the CDP geometry path). "3 mobile personas" = 3 mobile-layout desktop-Chromium participants, not
touch devices. Do not over-read the results as true mobile-device coverage. That describes the
default. With `execution.desktop.fidelity.mobileEmulation: true`, Chromium participants on a mobile
preset get a DevTools device-metrics override at the preset width, plus DPR, touch emulation and a
mobile user agent. That is still not physical-device fidelity.

## Watch-from-phone

Native live-desktop `--expose` is not supported on the concurrent path; only the computer-use
route live-serves a run (`src/cli/io.ts`). Today, watch it from a phone via `humanish observe --all
--expose --tunnel … --oauth …` against the run directory's Observer (the concurrent path writes
artifacts continuously and attaches per-participant runtime stream URLs to the live Observer).
