# Provider token exhaustion is an incomplete session

Two real OpenAI Responses calls on 2026-09-05 returned explicit output-limit
interruptions. Replaying each captured response through the 0.82.0 parser and
computer-use loop produced `passed / goal_satisfied`: an empty action list was
treated as a natural endpoint even when the provider said generation was
incomplete. The corrected parser and loop produce `incomplete / budget_reached`
with a reason that names the provider's output/context token limit.

| Captured response | Actual provider result | 0.82.0 replay | Corrected replay |
| --- | --- | --- | --- |
| Medium effort, 16 output tokens | Reasoning only; no visible message | `passed / goal_satisfied` | `incomplete / budget_reached` |
| No reasoning, 32 output tokens | Partial list ending after `10,` | `passed / goal_satisfied` | `incomplete / budget_reached` |

Both calls used `gpt-5.6-sol`, Standard service tier, and the same synthetic
request for the unabridged integers 1 through 1000. Each response reported 36
input tokens, no cache-read/write tokens, and output equal to its declared cap.
There were exactly two calls, no retries, no tools, no stored conversation, and
no E2B allocations. The recorded Standard estimate was $0.001248 combined;
this is not an invoice total. Request time, response size, request count, and
output limits were controlled separately from the lab's estimated-spend guard.

These are **two live provider captures and free engine replays**, not two live
desktop usability studies. Baseline replay used source commit
`f79741b449b02e9c24c89b25d5d269503f390f51`, the 0.82.0 release.

The projections in `tests/fixtures/openai-incomplete/` preserve the captured
status, incomplete reason, output shape/text, model settings, and usage.
Provider IDs are replaced or omitted; original response bodies and receipts
remain retained privately. OpenAI documents the same
[incomplete-response signal](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning).

The corrected loop retains usage, response identity, and labeled partial
narration. It stops before actions, safety acknowledgements, coordination
callbacks, or a closing request. An unrecognized explicit incomplete reason
is a named harness error, never participant abandonment or success. Existing
completed responses and legacy response fixtures without a status preserve
their behavior. Tests also exercise a provider-neutral interrupted turn carrying
actions; those actions are never dispatched.

This change exposes no new output-token setting and adds no hard provider
spending cap. The existing lab USD caps are checked after responses. Explicit
noncompleted statuses such as `failed`, `in_progress`, `queued`, and `cancelled`
were not live-captured. Negative contract tests vary only the status on a
captured response and confirm that these unexpected states fail closed as a
named harness error, preserving usage and taking no further actions.
