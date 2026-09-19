# Setup, inbox and camera reliability — 2026-09-19

This receipt separates command and fixture checks from paid participant proof.
Runtime bundles and screenshots remain outside the public repository. All
examples and room traffic used synthetic data.

## Setup

Thirteen compiled-CLI newcomer checks exercised route-specific `doctor`,
keyless first-run, missing credentials and optional-SDK cases without provider
dispatch. The setup implementation passed 272 focused tests. Local-agent auth
is checked through bounded CLI status commands; raw auth output is neither
printed nor retained. These checks establish local readiness diagnostics,
not remote account validity or quota.

## Synthetic inbox

Real SMTP delivery, loopback HTTP and desktop/phone Chromium checks covered
two distinct recipients, scoped message/plain/JSON links, unsupported scopes,
stale-scope cleanup and a long sender/header case. Captured CID raster, raster
data and reachable HTTP images decoded; unavailable references were explicit.
The focused comms suite passed 255 tests.

The shared operator inbox remains available. Scope identifiers prevent
accidental cross-recipient navigation, not intentional access by someone with
the catch address. Remote image failures still depend on the host; no image
proxy or email script execution was introduced. Older external catch servers
without the scope capability marker fail preflight with upgrade guidance.

## Camera room

The reusable [fixture](https://github.com/danielgwilson/humanish/tree/main/scripts/fixtures/video-room)
was exercised with an actual Humanish participant in visible Chrome and an
independent counterpart in a different owned hosted desktop. The participant
used the real browser camera prompt, joined, remained connected, and left.
No permission override was used for the participant.

| Observation | Participant peer | Independent counterpart |
| --- | ---: | ---: |
| Measured interval | 47.57 s | 53.25 s |
| Additional decoded frames | 476 | 482 |
| Additional rendered, changing frames | 467 | 482 |
| Additional received bytes | 1,777,896 | 2,228,952 |

The selected connection used server-reflexive UDP candidates. Leaving ended
the participant's capture tracks and notified the counterpart. Both desktops
were confirmed absent afterward.

A separate actual participant selected **Never allow**, saw the permission
error and “you have not joined” state, and found Join disabled. Native trace
and screenshots support this result. Its disposable telemetry collector raced
with teardown, so its final HTTP snapshot is not used as acceptance evidence.
An earlier refusal attempt stopped before model dispatch because a browser
window extended five pixels outside the capture; that failure was retained,
and its desktop was reclaimed. One deliberate retry used explicit geometry.

Parser, media and producer coverage passed 604 tests. Unsupported camera routes
and microphone-source injection fail before desktop/model dispatch. The live
happy path predates the later unsupported-route guards; the supported camera
implementation is unchanged by those guards.

The three participant allocations total an estimated $0.221320, including
$0.196840 in model use. The short independent-counterpart desktop is additional.
These are rate-table estimates, not provider invoices. All four exact owned
desktop allocations were confirmed absent.

This establishes a synthetic video-only Chromium call on one direct UDP path.
It does not establish audio, TURN, reconnect, a specific conferencing provider,
or physical-device behavior. The intermittent default-size geometry failure
remains a separate reliability concern.
