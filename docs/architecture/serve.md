# Serve: the run library surface

Date: 2026-08-02

Status: shipped — `loopback`, `exposed` (edge-authed), and `share-safe-open`
modes (`src/observer-serve.ts`, `src/observer-library.ts`, `src/serve-http.ts`,
`src/serve-exposure.ts`, `src/serve-tunnel.ts`; CLI wiring in `src/program.ts`).
The `/_humanish/api/*` control-plane namespace is reserved and answers `501`; no
mutating route ships.

Exposure auth is **tunnel-edge only**. As of 0.18.0 humanish carries NO
in-process auth: the hand-rolled capability-link (cookie/token/TTL, the whole
`observer-auth.ts` module and the `serve --auth link|none` flags) was removed as
a pre-1.0 breaking change. The gate now lives entirely at the edge — ngrok
`--oauth google` (with `--allow-email`/`--allow-domain` allow rules), or an
operator-secured `--public-url` (Cloudflare Access, Tailscale, a reverse proxy
you own).

## What serve is

`humanish serve` is the third observer surface, and the first whose subject is
the LIBRARY rather than a run:

- `humanish watch` — one ATTACHED run: the process that created the run serves
  it and may inject runtime stream URLs for live following (see the stream-URL
  doctrine below and `watch --expose`);
- `humanish observe` — one FINISHED run, re-served read-only;
- `humanish serve` — the whole local library under `.humanish/runs/`: a
  library index, per-run Observer pages, `/_humanish/history.json` polling, and
  optional edge-authenticated exposure beyond the machine.

The server binds `127.0.0.1` unconditionally (`serveObserverLibrary`); exposure
only ever happens through a tunnel or proxy forwarding to the loopback port.
`--expose` never changes the bind — it declares intent and requires an
authenticated edge (or `--safe`, see the fail-closed matrix).

## Fail-closed exposure matrix

One shared validator (`validateExposure` in `src/serve-exposure.ts`) governs
both `serve` and `watch`. `--expose` must ALWAYS resolve to a reachable public
origin (a `--tunnel` or a `--public-url`) — even under `--safe`, since an
origin-less exposed server is an unreachable loopback no-op. With an origin
present, exposure requires EITHER edge auth (`--oauth` on the ngrok edge, or a
`--public-url` you secure) OR `--safe` (share_ready runs only). A tunnel with
neither is a wide-open public URL to local bundles and is refused.

| `--expose` | `--tunnel` | `--oauth` | `--public-url` | `--safe` | Outcome |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | any | `loopback` (no exposure) |
| ✓ | ✓ | ✓ | — | any | OK → `exposed` (edge-authed; all runs unless `--safe`) |
| ✓ | ✓ | — | — | ✓ | OK → `share-safe-open` (public, share_ready only) |
| ✓ | ✓ | — | — | — | **REFUSED** `HUMANISH_SERVE_EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE` |
| ✓ | — | — | ✓ | any | OK → `exposed` (operator-secured edge) |
| ✓ | — | — | — | any | **REFUSED** `HUMANISH_SERVE_EXPOSE_REQUIRES_ORIGIN` (no reachable origin, even with `--safe`) |
| ✓ | — | ✓ | — | any | **REFUSED** `HUMANISH_SERVE_OAUTH_REQUIRES_TUNNEL` |
| ✓ | ✓ | ✓ | ✓ | any | **REFUSED** `HUMANISH_SERVE_OPTION_CONFLICT` (tunnel + public-url) |

Guard order (all before any bind/spawn): `--allow-email`/`--allow-domain`
without `--oauth` → `HUMANISH_SERVE_ALLOW_REQUIRES_OAUTH`; `--oauth` without
`--tunnel` → `HUMANISH_SERVE_OAUTH_REQUIRES_TUNNEL`; `--tunnel`+`--public-url` →
conflict; `--tunnel-domain` without `--tunnel` → conflict; `--expose` with no
tunnel and no `--public-url` (even under `--safe`) →
`HUMANISH_SERVE_EXPOSE_REQUIRES_ORIGIN`; `--expose` with an origin but without
edge auth and without `--safe` →
`HUMANISH_SERVE_EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE`; a tunnel/public-url without
`--expose` → `HUMANISH_SERVE_TUNNEL_REQUIRES_EXPOSE`/conflict. `--oauth google`
with NO allow rule is ALLOWED (any Google account authenticates) but pushes a
prominent warning recommending at least one `--allow-email`/`--allow-domain`.

The `watch` surface reuses the same validator but is stricter: a live,
in-progress run is never `share_ready` (raw, unverified screenshots), so `--safe`
would admit nothing. `watch --expose --safe` is therefore REFUSED outright with
`HUMANISH_WATCH_SAFE_NOT_APPLICABLE` (rather than silently ignoring the flag);
`watch --expose` ALWAYS requires edge auth (`--tunnel --oauth` or `--public-url`),
and is additionally refused with `--dry-run`/`--detach`/`--json` (no live desktop
/ no attached follow). An exposed watch serves ONLY the attached live run: its
`/_humanish/history.json` lists just that run and every other run id 404s
byte-identically to a nonexistent one, so a remote viewer can never enumerate or
reach any prior run's raw evidence (loopback watch still serves the full library).

## ngrok edge OAuth

`startNgrokTunnel` builds `ngrok http <port> [--url <domain>] [--oauth google
[--oauth-allow-email <addr>]… [--oauth-allow-domain <domain>]…] --log stdout
--log-format json`. ngrok authenticates the viewer at its edge before any request
reaches the loopback port; the stdout JSON parser skips every line except
`msg:"started tunnel"`, so ngrok's `--oauth has been deprecated` info line (it is
still accepted and functional on ngrok 3.39.x) is ignored automatically. The
forward-compatible path if ngrok removes the flags is a Traffic Policy YAML — a
documented fast-follow, out of scope for 0.18.0.

## Threat model

**No in-process secret to leak.** The old capability-link posture (a token in
the URL path, an HttpOnly cookie, unfurler/history leakage, host-only cookie
scope, TTL/revocation) is gone with the module. There is no secret in any URL
served by humanish; the operator's edge owns authentication and session
lifetime.

**DNS rebinding and the strict Host allowlist.** A malicious page can point an
attacker-controlled DNS name at 127.0.0.1 and read a permissive local server
from the victim's browser. Serve keeps a strict Host allowlist in ALL modes —
loopback names plus the declared tunnel/public origin only — and answers `421
Misdirected Request` otherwise. Even the unauthenticated loopback default never
trusts an arbitrary Host header. The live `serveObserver` server gains the same
allowlist + security headers under its new `exposed` option (see observer.md), so
`watch --expose` is not a header-less, rebinding-vulnerable surface.

**Security headers.** Every response carries `cache-control: no-store`,
`referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
`x-frame-options: DENY`, and `x-robots-tag: noindex, nofollow`
(`buildServeSecurityHeaders`).

## Mode-to-boundary mapping

| Mode | Invocation | Boundary class |
| --- | --- | --- |
| `loopback` | `humanish serve` | Capture-side trust: readable only by whoever can already read gitignored `.humanish/` on this machine; no new boundary is crossed. |
| `exposed` | `--expose --tunnel ngrok --oauth google …`, or `--expose --public-url <origin>` | Edge-authed exposure: only viewers who clear the edge OAuth (or the operator's own edge) reach the loopback server, which then serves everything it grants unless `--safe` composes in. The gate is the edge, not humanish. |
| `share-safe-open` | `--expose --safe --tunnel ngrok` (no `--oauth`) | Genuine publishing behind the feedback-grade `share_ready` gate: only runs that pass verify are served — admission is re-checked when a bundle changes and re-verified within a bounded window (default 30s); everything else is absent, 404ing byte-identically to a nonexistent run (no existence oracle). |

## Stream-URL doctrine

Live desktop stream URLs (auth-bearing hosted-VNC links) are never served by the
LIBRARY surface, in any mode, and the guarantee is layered:

- **structural** — runtime stream URLs live in a `WeakMap` keyed by the watch
  process's in-memory `ObserverResult` (`src/observer.ts`) and are never
  persisted into any bundle artifact; serve is a separate process reading disk,
  so there is nothing for it to find;
- **defensive** — the serve handler passes an explicit empty array at its
  `serveRunPath` call site, so a future refactor that makes injection ambient
  would still serve zero stream URLs here;
- **tested** — the serve suite pins a no-injection test: observer data served
  through the library surface carries no runtime stream URLs.

`watch --expose` is the ONE surface that deliberately serves runtime E2B stream
URLs — the attached watch process genuinely holds them, and streaming the live
desktop is the whole point of watching from a phone. It is safe only because the
edge authenticates first, and the URLs are still never persisted (they are
injected into the in-memory bundle, not disk). See observer.md.

## The share_ready doctrine

`share_ready` was designed as the bar for FEEDBACK payloads: evidence eligible
to leave the machine inside a public issue draft. Serve's `share-safe-open` mode
extends that same gate to arbitrary-audience BROWSING, which is a broader
exposure of the same artifacts. The honest caveat carries over unchanged:
`humanish verify` does not yet detect free-form PII/PHI (names, emails, medical
identifiers — see the README's public-safety boundary and issue #108), so
`share_ready` means the automated secret/path scan passed, not that a human would
publish every pixel. Maintainers should treat open mode accordingly: synthetic
data upstream, review before exposing, and treat `--safe` without edge auth as
publishing because it is.

## v2 control-plane seam contract

The reserved `/_humanish/api/*` namespace answers `501` with
`HUMANISH_SERVE_CONTROL_PLANE_DISABLED` to any request. Because the in-process
auth gate is gone, a request that clears the edge (or a loopback caller) reaches
the `501` directly — there is no `401`-first anymore. No run artifact can ever
shadow the namespace. The seam is already typed: `createServeRequestHandler`
accepts an optional `ServeControlPlane`, and v1 always passes `undefined`. Before
any mutating route ships, the contract is:

- an operator identity distinct from a viewer — but sourced from the edge/control
  plane, not a humanish-minted cookie;
- mutating routes require CSRF defenses appropriate to the chosen edge session;
- the spend rule is invariant 3 applied to remote hands: a phone-initiated LIVE
  run needs its own affirmative declaration at serve startup (an explicit opt-in
  naming the lab and budget), never a default the viewer UI can reach.

## Why not Better Auth here

Better Auth is a strong TypeScript auth framework, but it is deliberately NOT
used for this CLI serve surface: serve is an ephemeral, no-database,
per-invocation loopback server whose only job is to hand persisted evidence to an
already-authenticated edge. A password/session/social-login framework with a
schema and a datastore is the wrong shape for a process that lives for the length
of a `Ctrl-C`. The right home for Better Auth is a FUTURE hosted humanish
dashboard / control-plane — a persistent, multi-user service with a database —
where accounts, org membership, and durable sessions actually exist.

## Future work

- **Traffic Policy for ngrok.** Migrate off the deprecated `--oauth*` flags to a
  generated Traffic Policy YAML once ngrok requires it (the `yaml` dep is already
  available); pin the behavior in `serve-tunnel` tests first.
- **Google Fonts inlining for per-run observer pages.** The library index is
  self-contained; the per-run observer HTML still references remote Google Fonts,
  which degrade gracefully offline but should be inlined (or dropped) so a served
  run page makes no third-party requests from a viewer's browser.
- **Shipped in 0.18.0: `watch --expose`.** Remote LIVE following of a run,
  including its live E2B desktop stream, behind the same edge auth — the one
  surface that deliberately serves runtime stream URLs. See observer.md and
  live_watch_wiring.
