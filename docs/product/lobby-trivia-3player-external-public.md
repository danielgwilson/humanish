# Example: 3 mobile personas share ONE public multiplayer lobby at once

`humanish/labs/lobby-trivia-3player.yaml` is a worked example of the EXTERNAL-PUBLIC shared-world route
(#164 phase 2): three mobile-LAYOUT personas play the SAME multiplayer lobby on a REAL public
deployment simultaneously, watched in ONE Observer. Point `subject.appUrl` + `subject.publicTarget` at
a public deployment YOU own/operate.

## What it does

- The public site is the shared plane DIRECTLY — no clone, no getHost, no subject sandbox, no seed.
- A host-first barrier: the `host: true` seat creates the lobby; the orchestrator reads the
  `/lobby/CODE` from the host's CDP-observed URL and threads it into the follower Join missions.
  Followers go through the real Join flow (a direct `/lobby/CODE` visit does not auto-join a
  non-member).
- Convergence — all three seats reaching one `/lobby/CODE` — is the pass signal (a digest-only
  `lobbyConvergenceDigest`), plus temporal co-occupancy of the three seats' windows.

## Mobile fidelity caveat (read before over-reading the results)

The seats are `device: mobile` (414×896) and `device: small-mobile` (360×740). On the E2B-desktop
route the rendered WIDTH is floored to `MIN_DESKTOP_RENDER_WIDTH` (500): Chrome refuses a window
narrower than ~500 CSS px, and a narrower X screen let the window overflow and clip the page
(0.20.3, #304). So both presets render at **500 wide**, `mobile` and `small-mobile` are identical in
layout on this route, and this example does NOT currently exercise two different mobile widths. Only
the HEIGHT renders as declared (896 and 740).

Note that `desktopGeometry.screen.verified` checks the FLOORED number against itself, so a matching
`verified` block is not evidence that the preset width rendered. Read `requested` against the preset
in `device-presets.ts` if you need to know.

There is NO touch input, and isMobile/DPR are prompt-signal + metadata (DPR renders only via the CDP
geometry path). So "3 mobile personas" means 3 mobile-LAYOUT desktop-Chromium seats, NOT touch
devices. If a flow needs true touch/tap semantics, these seats will not exercise it. True sub-500
CSS-viewport rendering is the #221 CDP-device-emulation upgrade.

## Run it

Dry-run (the default, $0 — proves the plumbing + the honesty contract, no sandboxes, no tokens):

```
humanish lab run lobby-trivia-3player          # or: humanish watch lobby-trivia-3player
```

Live (opens 3 real mobile-layout seats against the public app):

```
# flip scenario.mode to live in the lab (or override), then:
humanish watch lobby-trivia-3player --env-file .env.local   # OPENAI_API_KEY + E2B_API_KEY
```

Watch it from a phone (today): serve the run directory's Observer through an authed edge —

```
humanish serve --expose --tunnel <provider> --oauth <provider> --allow-emails you@example.com
```

Native live-desktop `--expose` streaming on the concurrent path (watch the 3 live desktops, not just
the evolving Observer artifacts) is a 0.20.1 fast-follow.

## Honesty

This is a real public-application study of a deployment the operator attests they own/operate
(`subject.publicTarget: { owner, authorized: true }` — author-trust, unverifiable by the harness).
Attribution stays `shared-world` (N seats, ONE plane), but every strength claim degrades honestly and
is asserted-absent by verify: provenance `external-public` (not seeded); NO synthetic attestation (you
cannot claim synthetic on a real site); plane control is operator-attested, not harness-controlled; NO
authoritative shared-state proof; concurrency by temporal co-occupancy + observed lobby convergence.
No one run implies adoption, scale, or repeatability.

## Before a live run against a third-party site

The verified lobby-trivia lobby mechanics (createLobby/joinLobby → `/lobby/CODE`, the 6-char
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` alphabet, non-auto-join on a direct visit) are read from current
source and could change on the next deploy. The two coupling points to re-verify are the lobby-code
regex (`/\/lobby\/([A-Z2-9]{6})(?:$|[/?#])/`, tolerant of a locale prefix and query/hash) and the
follower Join-flow mission wording.
