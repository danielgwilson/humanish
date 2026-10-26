# Anthropic Messages computer-use fixtures

Response bodies from `POST /v1/messages` with `model: claude-haiku-5-5` and the
`computer_toolset_20260801` toolset. The screenshots sent were synthetic: a 1440x950 to-do
page with one text box and an Add button. Every `tool_use` id was replaced with a unique
synthetic id, the message and request ids were replaced, and thinking signatures read
`<signature removed>`. Field names, stop reasons, content blocks and usage counts are as the
API returned them.

Captured on 2026-10-26:

- `batch.json`: a text block, then five member calls (`left_click`, `type`, `left_click`,
  `wait`, `screenshot`), effort `medium`, with the compaction beta on, so `usage.iterations`
  is present.
- `end-turn.json`: the reply after that batch's results: one text block, `end_turn`.
- `closing-json.json`: a closing request with `tool_choice: none` and the JSON asked for in
  text.
- `thinking-batch.json`: effort `high`, `display: summarized`: a thinking summary, text, then
  five member calls. No `iterations` (no compaction beta).
- `replan-after-failure.json`: the reply after a batch whose first result was `is_error` and
  the rest the halt text.
- `closing-strict.json`: a closing request with `output_config.format` set.
- `max-tokens.json`: `max_tokens: 64`; the reply stops inside its first member call.
- `error-400-missing-toolset-name.json`: the 400 body for a `tool_result` without
  `toolset_name`.
- `mid-batch-screenshot.json`: a reply from a live Taskly run, effort `medium`: a thinking
  summary, text, then six member calls (`left_click`, `wait`, `screenshot`, `left_click`,
  `wait`, `screenshot`), so its first `screenshot` comes before the end of the batch.

Captured on 2026-10-26 from the provider itself, driven turn by turn with screenshots recorded
in a live Taskly session:

- `compaction.json`: request 22 of that session (43 messages), sent with `compact_20260112` at
  a 60,000-token trigger and the provider's summary instructions. The reply starts with a
  `compaction` block holding the participant's notes, and `usage.iterations` has a `compaction`
  entry, with its cache write, ahead of the `message` entry.

Built from the documented shapes, not captured, because they cannot be produced on demand:

- `documented-refusal.json`: `stop_reason: refusal` with `stop_details.category: cyber`
  (docs: refusals and stop details).
- `documented-error-429.json`, `documented-error-529.json`: the error body shape from the
  errors page.

Derived from a capture:

- `closing-report.json`: `closing-strict.json` with its text replaced by a closing report in
  humanish's schema (`outcome`, `summary`, `frictionReports`, `impressions`). The envelope,
  thinking block and usage are the capture's.
