# External-public shared-world plane + the CDP lobby-code handoff (#164 phase 2, 0.20.0)

The concurrent shared-world backend now has TWO plane classes. This note documents the new
`external-public` class and the host-first handoff barrier that makes cross-persona coordination on a
real public app possible without any persona-to-persona messaging.

## The two plane classes side by side

| | provisioned-getHost (historical) | external-public (new) |
|---|---|---|
| Shared plane | a `clone`/`local-tree` subject served + `getHost`-exposed IN-SANDBOX | a real operator-OWNED public deployment (`source: app-url`) used DIRECTLY |
| Harness role | MINTED and controls the host URL | OBSERVES that the seats converged on ONE origin (tolerant of a declared→observed redirect) |
| Subject sandbox | one (headless service host) + N actor desktops | NONE — only N actor desktops |
| Attestation | `subject.exposure: synthetic` (synthetic seeded data) | `subject.publicTarget: { owner, authorized }` (you own/operate it) |
| Provenance | `subject.state.provenance == seeded` | `subject.state.provenance == external-public` |
| Plane identity | `plane.hostDigest`; every `routeHostDigest == it` (harness-minted) | `plane.publicOriginDigest`; every CDP-observed `routeHostDigest == it` (observed) |
| Shared-state proof | authoritative in-sandbox checkpoint `stateSeries` + delta-on-pass | NONE — `stateSeries` OMITTED (Option A) |
| Concurrency-on-pass | ≥2 overlapping windows AND a state delta at/after an overlap start | ≥2 overlapping windows ONLY (temporal co-occupancy) |
| Extra proof | — | `lobbyConvergenceDigest` (all seats on one `/lobby/CODE`) |

THE HONEST DELTA. getHost = harness-minted host + synthetic-seeded attestation + authoritative
in-sandbox checkpoint `stateSeries`. external-public = operator-attested public origin + NO synthetic
claim + NO authoritative shared-state proof (concurrency evidenced by temporal co-occupancy +
observed lobby-path convergence only). Every downgrade is asserted-ABSENT by verify, never silently
dropped: `plane.exposure` MUST be absent (claiming synthetic on a real site is a lie),
`plane.hostDigest` MUST be absent, the `seeded`/`synthetic` attribution limits are FORBIDDEN, and the
external-public honest-downgrade limits are REQUIRED.

Why the getHost synthetic gate is deliberately NOT reachable from the app-url branch: that gate
(`concurrentSharedWorldValidationReason` → `plane.exposure == synthetic` + a `0.0.0.0` bind +
`subject.state.provenance == seeded`, `run.ts` verify) exists because a getHost URL is
internet-reachable AND harness-owned — real data behind a harness-exposed URL is the hazard. A public
site the harness neither provisioned nor exposed has NEITHER property, so the gate's hazard does not
exist there. The app-url branch is validated by `externalPublicSharedWorldValidationReason` and is
reached before the getHost gate; a snapshot regression test pins the getHost path byte-unchanged.

## The CDP lobby-code handoff barrier

The crux — reading a seat's live URL mid-run — is ALREADY implemented: `makeChromeBrowserStateObserver`
(`cua-actor-lab.ts`) runs an in-sandbox `node -e` script that resolves the seat's Chrome CDP port,
selects the seat's page, and sends `Runtime.evaluate({ url: location.href, title, text })` over the
page's `webSocketDebuggerUrl`. `createE2BDesktopExecutor` stamps `observation.url` from it every turn.
`CuaObservation.url` is RUNTIME-ONLY by contract (it drives `stopWhen`/progress but is never persisted
raw into the trace).

The 0.20.0 delta is a single surgical callback: `CuaLoopOptions.onObservedUrl?(url)`, invoked right
after every `executor.observe()` (the initial observe and each loop observe) with `observation.url`,
threaded through `CuaActorSessionOptions` → `CuaLaneDeps` → the concurrent orchestrator. No new CDP
code; no cineguessr change.

Flow, a host-first barrier inside `runConcurrentSharedWorld`'s fan-out:

1. **Designated host.** Exactly one roster lane carries `host: true` (validated). Its mission = create
   the shared lobby; its browser opens `subject.appUrl`.
2. **Latch.** The orchestrator creates `lobbyCodeLatch = deferred<string>()` before fan-out. The host
   lane's `onObservedUrl` matches `/\/lobby\/([A-Z2-9]{6})(?:$|[/?#])/` (a locale prefix
   `/en/lobby/CODE` and a query/hash suffix are tolerated), extracts CODE, and resolves the latch. The
   host KEEPS PLAYING after resolving, so its window overlaps the followers'.
3. **Barrier.** Follower lanes (`host` absent) do NOT compose a mission or open their target until
   `await Promise.race([lobbyCodeLatch.promise, timeout(HANDOFF_DEADLINE_MS)])`. On resolve, CODE is
   threaded into each follower's mission ("…choose Join, enter lobby code {CODE}…") — NOT a raw URL
   navigation, because a direct `/lobby/CODE` visit does not auto-join a non-member (cineguessr's
   lobby page redirects unknown/non-member sessions home); the follower goes through the real Join
   flow.
4. **Convergence confirmation.** Each follower's own `onObservedUrl` confirms it reached `/lobby/CODE`;
   this observed convergence becomes the `lobbyConvergenceDigest` — the pass signal that the handoff
   LANDED rather than merely being instructed. Recorded only when EVERY seat converged on ONE code.
5. **Fail-closed timeout.** If the host never yields a `/lobby/CODE` within `HANDOFF_DEADLINE_MS`
   (default 120s, capped by `execution.timeoutMs`; injectable in tests), the latch rejects; every
   follower fails closed WITHOUT opening (no wasted turns against a codeless home page); the run
   returns `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT` and the bundle records the host
   window + a handoff-failed outcome for followers. A host that reaches the lobby but whose followers
   fail to JOIN is a normal per-lane non-pass (the concurrency-on-pass gate then simply won't see ≥2
   overlap, and the verdict stays non-pass, honestly), not a whole-run abort.

> **Temporary shim (tracked by #296).** This CDP URL-relay handoff — reading the host's `/lobby/CODE`
> off its own browser and threading it into the follower missions — is a TEMPORARY coordination shim.
> It is to be augmented/replaced by the actor message bus (faux SMS/email invite) in #297: the
> human-realistic version is the HOST SENDING the invite link and followers RECEIVING and tapping it,
> rather than the orchestrator relaying the code out-of-band.

## Observed-origin convergence (not declared)

The convergence proof is about what the seats OBSERVED, not what was DECLARED. `plane.publicOriginDigest`
is the sha256-16 of the ONE origin the seats' CDP-observed final URLs converged on; verify requires every
`laneWindow.routeHostDigest` to agree on it. A normal cross-origin redirect (apex→www, http→https;
cineguessr.com 307-redirects) makes the OBSERVED origin differ from the declared `subject.appUrl`, which
is EXPECTED and must never fail the run — so the declared origin is recorded separately as
`plane.declaredOriginDigest` for reference and is NEVER asserted equal to the observed one. Operator
OWNERSHIP rests on the `subject.publicTarget.authorized` attestation + the declared `appUrl`, NOT on
digest equality. Verify fails closed only when the seats did not converge on a single OBSERVED origin
(it then lists the distinct observed origin digests).

## Hygiene

The runtime `location.href` (and the 6-char CODE inside it) is never persisted raw: `onObservedUrl` is
runtime-only; the threaded CODE flows only into the follower's composed prompt (never a raw bundle
field) and is scrubbed from all narration once latched; the shared origin and lobby path persist ONLY
as sha256-16 digests (`publicOriginDigest`, `lobbyConvergenceDigest`). This matches the existing
e2b-URL / host-digest redaction discipline.

## Mobile fidelity caveat

The example roster runs mobile-LAYOUT seats (`device: mobile` 414×896, `small-mobile` 360×740). On the
E2B-desktop route the rendered WIDTH is floored to `MIN_DESKTOP_RENDER_WIDTH` (500) because Chrome
refuses a narrower window and a narrower X screen clipped the page (0.20.3, #304), so both presets
render at 500 wide and are identical in layout; only HEIGHT renders as declared.
`desktopGeometry.screen.verified` compares the floored number with itself, so it does not attest the
preset width. There is NO touch input, and `isMobile`/DPR are prompt-signal + metadata (DPR renders
only via the CDP geometry path). "3 mobile personas" = 3 mobile-LAYOUT desktop-Chromium seats, not
touch devices. Do not over-read the results as true mobile-device coverage. True sub-500 rendering is
the #221 upgrade.

## Watch-from-phone

Ship the run + evidence here; native live-desktop `--expose` on the concurrent path is a clean,
separable 0.20.1 fast-follow (its whole diff is "reuse `startExposedObserver` on the concurrent
observer server"). Today, watch it from a phone via `humanish serve --expose --tunnel … --oauth …`
against the run directory's Observer (the concurrent path writes artifacts continuously and attaches
per-seat runtime stream URLs to the live Observer).
