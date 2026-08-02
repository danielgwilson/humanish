# Serve: the run library surface

Date: 2026-08-02

Status: shipped in v1 — loopback, capability-link, and share-safe-open modes
(`src/observer-serve.ts`, `src/observer-auth.ts`, `src/observer-library.ts`,
`src/serve-tunnel.ts`; CLI wiring in `src/program.ts`). The `/_humanish/api/*`
control-plane namespace is reserved and answers `501`; no mutating route ships.

## What serve is

`humanish serve` is the third observer surface, and the first whose subject is
the LIBRARY rather than a run:

- `humanish watch` — one ATTACHED run: the process that created the run serves
  it and may inject runtime stream URLs for live following;
- `humanish observe` — one FINISHED run, re-served read-only;
- `humanish serve` — the whole local library under `.humanish/runs/`: a
  library index, per-run Observer pages, `/_humanish/history.json` polling, and
  optional exposure beyond the machine.

The server binds `127.0.0.1` unconditionally (`serveObserverLibrary`); exposure
only ever happens through a tunnel or proxy forwarding to the loopback port.
`--expose` gates every request behind a capability link: a per-process secret
whose SHA-256 digest is compared timing-safe (`verifyTokenDigest`), minting an
HttpOnly viewer-session cookie with a bounded TTL. Ctrl-C revokes the link and
all sessions (`revokeAll` on close); restarting mints a new link.

## Threat model

**The tunnel-agent-connects-from-loopback trap.** The classic mistake on a
tunneled local server is "peer address is 127.0.0.1, so this is the local
operator — skip auth." The tunnel agent connects from loopback, so that
shortcut disables auth in exactly the deployment it exists to protect. Serve
auth therefore ignores source address entirely: every route below the auth
mint requires a valid session, loopback peer or not.

**Referer and unfurler leakage.** The capability URL embeds the secret in the
path. Every response carries `referrer-policy: no-referrer` (plus `no-store`
and `x-robots-tag: noindex`), so a link inside a served page can never leak the
origin or token onward. The residual channel is the operator pasting the link
into a chat app whose unfurler prefetches it server-side — which is why the
link is deliberately NOT single-use (a preview fetch must not burn it before
the phone taps it), and why the README steers sharing toward AirDrop or manual
entry.

**Host-only cookie scope on shared tunnel domains.** The session cookie sets
no `Domain` attribute (`buildSessionCookie`), so it is host-only. On a shared
tunnel apex (many customers under one provider domain), a `Domain` cookie
would be presented to sibling subdomains an attacker can rent; a host-only
cookie can never leave the exact public origin the operator declared.

**DNS rebinding and the strict Host allowlist.** A malicious page can point an
attacker-controlled DNS name at 127.0.0.1 and read a permissive local server
from the victim's browser. Serve keeps a strict Host allowlist in ALL modes —
loopback names plus the declared tunnel/public origin only — and answers
`421 Misdirected Request` otherwise. Even the unauthenticated loopback default
never trusts an arbitrary Host header.

**Token in phone history (residual).** After the tap, the capability URL
remains in the phone's browser history and share sheet. TTL-bounded sessions,
per-process minting, and Ctrl-C revocation bound the damage — a link recovered
from history after the process exits or restarts is dead — but while the same
process runs, a leaked history entry is a live credential. This risk is
accepted and documented, not solved.

## Mode-to-boundary mapping

| Mode | Invocation | Boundary class |
| --- | --- | --- |
| `loopback` | `humanish serve` | Capture-side trust: readable only by whoever can already read gitignored `.humanish/` on this machine; no new boundary is crossed. |
| `capability-link` | `--expose` (auth defaults to `link`) | Declared-friction exposure: publishing-adjacent, not publishing. Anyone holding the secret link reads everything it grants until Ctrl-C — the printed warning names the run count, including non-`share_ready` runs unless `--safe` composes in. |
| `share-safe-open` | `--expose --safe --auth none` | Genuine publishing, behind the feedback-grade `share_ready` gate: only runs that pass verify are served — admission is re-checked when a bundle changes and re-verified within a bounded window (default 30s), so it is fresh, not perfectly live; everything else is absent, 404ing byte-identically to a nonexistent run (no existence oracle). |

## Stream-URL doctrine

Live desktop stream URLs (auth-bearing hosted-VNC links) are never served by
this surface, in any mode, and the guarantee is layered:

- **structural** — runtime stream URLs live in a `WeakMap` keyed by the watch
  process's in-memory `ObserverResult` (`src/observer.ts`) and are never
  persisted into any bundle artifact; serve is a separate process reading disk,
  so there is nothing for it to find;
- **defensive** — the serve handler passes an explicit empty array at its
  `serveRunPath` call site, so a future refactor that makes injection ambient
  would still serve zero stream URLs here;
- **tested** — the serve suite pins a no-injection test: observer data served
  through the library surface carries no runtime stream URLs.

A `--live-streams` flag on serve was considered and deliberately refused: the
persisted bundle carries no stream URLs, so the flag would be a claim without a
mechanism (invariant 6). Remote live following belongs to a designed
`watch --expose` (see Future work), where the attached process actually holds
the URLs.

## The share_ready doctrine

`share_ready` was designed as the bar for FEEDBACK payloads: evidence eligible
to leave the machine inside a public issue draft. Serve's open mode extends
that same gate to arbitrary-audience BROWSING, which is a broader exposure of
the same artifacts. The honest caveat carries over unchanged: `humanish
verify` does not yet detect free-form PII/PHI (names, emails, medical
identifiers — see the README's public-safety boundary and issue #108), so
`share_ready` means the automated secret/path scan passed, not that a human
would publish every pixel. Maintainers should treat open mode accordingly:
synthetic data upstream, review before exposing, and treat `--safe --auth
none` as publishing because it is.

## v2 control-plane seam contract

The reserved `/_humanish/api/*` namespace answers `501` with
`HUMANISH_SERVE_CONTROL_PLANE_DISABLED` in v1 to any request that clears the
auth gate — so under `--expose --auth link` a session-less request gets the
uniform `401` first, and the `501` is what an authenticated (or loopback) caller
sees. No run artifact can ever shadow the namespace. The seam is already typed:
`createServeRequestHandler` accepts an optional `ServeControlPlane`, and v1
always passes `undefined`. Before any mutating route ships, the contract is:

- sessions grow a real scope split — today every session is scope `viewer`;
  operators get a DISTINCT operator token, never an upgraded viewer cookie;
- mutating routes require double-submit CSRF on top of the operator session,
  because a cookie alone is exactly what a cross-site request forges;
- the spend rule is invariant 3 applied to remote hands: a phone-initiated
  LIVE run needs its own affirmative declaration at serve startup (an explicit
  opt-in naming the lab and budget), never a default the viewer UI can reach.

## Future work

- **Persistent capability links.** A link that survives restart is a stored
  secret and needs a real secret-storage design (keychain/agent integration,
  rotation, revocation records) — not a `--token <value>` CLI string, which
  would land in shell history and process listings.
- **Google Fonts inlining for per-run observer pages.** The library index is
  self-contained; the per-run observer HTML still references remote Google
  Fonts, which degrade gracefully offline but should be inlined (or dropped)
  so a served run page makes no third-party requests from a viewer's browser.
- **`watch --expose --live-streams`.** Remote LIVE following is a separate
  design: the attached watch process genuinely holds runtime stream URLs, so
  it can expose them deliberately — with the same capability-link gate and its
  own doctrine for auth-bearing hosted-desktop URLs.
