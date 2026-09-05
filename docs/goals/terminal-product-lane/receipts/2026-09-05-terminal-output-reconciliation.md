# Terminal output delivery reconciliation

Date: 2026-09-05. Follow-up to [issue #667](https://github.com/danielgwilson/humanish/issues/667).

Two real terminal studies, documented in the [egress-auth receipt](2026-09-05-runtime-egress-auth.md),
received their complete stdout twice from E2B: first through callbacks, then as
`commands.run`'s returned stdout. The producer appended both deliveries, doubling
the persisted usage records. The repeated final payloads were 16,131 and 11,214
UTF-8 bytes. No second actor session produced them.

The fix tracks callback delivery independently for stdout and stderr using byte
counts and incremental hashes. When returned output begins with the exact
already-delivered prefix, only its unseen suffix is appended. Returned-only and
nonmatching output remain supported. Participant text and usage records are not
globally deduplicated; repeated lines and equal-valued legitimate turns survive.

Known values are also scrubbed across retained chunks before artifacts are
written, in both per-stream and combined transcript order. This protects a
secret split between a streamed prefix and returned tail, including interleaved
stdout/stderr fragments, while preserving event order. If capture stops inside
a known key, a bounded discarded prefix completes redaction of the retained
fragment; discarded text is never added to evidence.

## Replay proof from the retained live streams

The two original bundles were left unchanged. Their actual callback chunks and
returned complete stdout were replayed through the corrected live orchestration
using an injected transport. This is deterministic replay of captured wire data,
not two new live actors. No provider call or billable sandbox was made.

| Original run | Original persisted usage | Reconciled usage | Reconciled usage records | Verification |
| --- | --- | --- | --- | --- |
| `terminal-egress-prepared-20260905-actor-1` | 188,650 input / 2,814 output | 94,325 input / 1,407 output / 55,936 cached input | 1 | Passed |
| `terminal-egress-prepared-20260905-actor-2` | 238,242 input / 3,098 output | 119,121 input / 1,549 output / 88,448 cached input | 1 | Passed |

Focused tests also cover callback-only, returned-only, complete dual delivery,
partial prefixes, Unicode byte boundaries, separate stdout/stderr delivery,
nonmatching fallback, repeated participant lines, equal-valued usage turns,
split known keys (including across streams or the capture cap), and avoiding a
second charge against the transcript cap for replayed stdout. The committed usage event is a minimal identifier-free record
copied from the first retained live stream, not a guessed provider response.

The earlier model-cost estimate from unique deliveries remains $0.0759273 for
both real studies combined. This fix corrects future capture; it does not rewrite
old bundles, establish invoice totals, or add a provider spending limit.
