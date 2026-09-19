# Disposable video-room fixture

This synthetic two-person room exercises the camera-permission, preview, join,
receive-video and leave flow. It is a proof target for Humanish, not a conferencing
integration or production room server. No participant or counterpart accounts
are needed. Run only on isolated, disposable infrastructure with an unpredictable
room path, synthetic video, and explicit resource cleanup.

```sh
python3 server.py --bind 127.0.0.1 --port 8765 --room synthetic-local-check
```

Open `/room/synthetic-local-check/` as the participant and the same URL with
`?role=peer` in a separate browser as the counterpart. The counterpart joins
programmatically with an animated canvas feed. The participant must enable a
camera through the real browser permission dialog, then join. No microphone is
requested. A permission refusal or missing camera remains visible and prevents
joining. Leaving closes the connection and stops capture tracks.

The server keeps bounded signaling and proof data in memory; it serves no other
files. `<room path>proof` returns timestamped page events and per-peer samples
from WebRTC `getStats()` plus rendered-frame/content-change counters. Treat live
URLs, SDP, network data and screenshots as private runtime evidence. The unique
path scopes an isolated exercise; it is not production authentication.

Acceptance requires both separate peers to show increasing decoded frames,
received bytes and rendered frames over at least 30 seconds. A connected label
or local camera preview alone is insufficient. Across-machine proof must name
the topology; same-machine checks cannot establish WAN connectivity. STUN is
configured; TURN, audio, provider-specific rooms, reconnection and production
access controls are outside this fixture's coverage.
