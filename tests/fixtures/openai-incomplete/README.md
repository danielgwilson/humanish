# Captured Responses output-limit results

Two real, direct OpenAI Responses requests on 2026-09-05 used `gpt-5.6-sol`,
Standard service tier, no tools, no retained conversation, and a synthetic prompt
asking for the unabridged integers 1 through 1000. There were no retries or E2B
allocations.

- `reasoning-only.json`: medium reasoning, `max_output_tokens: 16`; all 16 output
  tokens were reasoning, with no visible message.
- `partial-message.json`: reasoning disabled, `max_output_tokens: 32`; visible
  output stopped after `10,`.

Both returned `status: incomplete` and
`incomplete_details.reason: max_output_tokens`. Each reported 36 input tokens,
zero cache-read/write tokens, and its declared output limit. Combined estimated
Standard model cost was $0.001248; this is an estimate, not an invoice.

These projections preserve captured status, model settings, output shape/text,
and usage. Response IDs are synthetic; output IDs and unrelated fields are
omitted. Original response bodies and request receipts remain retained privately.

OpenAI documents this shape in [the reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning).
