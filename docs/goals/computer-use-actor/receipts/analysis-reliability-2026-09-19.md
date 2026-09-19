# Analysis request reliability — 2026-09-19

This pass used an existing twelve-participant recording with 344 captures. Raw
recordings and provider output remain in private operator storage; no target
application or participant transcript is included here.

The original automatic request failed near Node fetch's separate five-minute
header deadline. Its cause was not retained, so attributing that particular
failure to the transport timer remains an inference. A separate attempt with a
longer transport deadline exhausted 16,384 output tokens and returned incomplete.
Neither attempt was overwritten or silently retried.

The candidate uses one request-scoped Undici dispatcher. Humanish's abort signal
bounds the entire request; no process-global dispatcher is changed. The default
timeout is 600 seconds and output allowance is 32,768 tokens, including reasoning.
The default model and separate $3 admission budget are unchanged. A larger study
can still be declined by admission until the operator explicitly raises its limit.

One deliberately admitted candidate request used the default model, instructions,
timeout and output allowance, with an explicit $15 admission ceiling. It sent the
same selected evidence: 800 entries and 40 captures. It completed in 292.695
seconds, passed structural and evidence-reference validation, and returned twelve
participant reviews, six findings and thirteen concern reviews. Reported usage was
113,897 input and 17,289 output tokens, with an estimated cost of $2.288155. Its
`partial` artifact status records sampled evidence coverage; the provider request
completed successfully. Model interpretation is not certified by schema validation.

Keyless regression proof:

- A real loopback HTTP response outlives a deliberately short process fetch
  header timeout using the candidate provider. The unmodified-fetch control
  fails with `UND_ERR_HEADERS_TIMEOUT` against the same delayed server.
- Stalled headers, stalled response bodies and caller cancellation release the
  connection, retain unknown usage and make exactly one request.
- Known transport causes map to fixed safe codes. Unknown exception messages,
  URLs and arbitrary codes are not persisted.
- Existing HTTP failure, refusal, incomplete output, response-size, evidence and
  automatic-analysis lifecycle tests remain required.

Commands: `pnpm exec vitest run tests/study-analysis-provider.test.ts
tests/study-analysis-transport.test.ts tests/automatic-analysis.test.ts` and the
existing full release gates. The focused run passed 159 tests. Live evidence
demonstrates one completed large-study attempt, not a guarantee about provider
latency or future model output.
