# Captured Claude Code stream-json result

One real Claude Code 2.1.285 session on 2026-09-30, spawned with the same arguments as
`startClaudeSession` (`claude -p --input-format stream-json --output-format stream-json --verbose
--allowedTools Read`), default model `claude-opus-5-5`, signed in with a subscription account. The
prompt was synthetic: it asked the model to reply with a fixed humanish turn object. No screenshot
was sent and no tool ran.

`result-turn.json` is the `result` message of the session's second user turn. Its `usage` block is
verbatim. It reports `input_tokens: 2`, `cache_read_input_tokens: 30490` and
`cache_creation_input_tokens: 2256`, so the request's total input was 32748 tokens. Anthropic's
`input_tokens` counts only the tokens after the last cache breakpoint, as the
[prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)
states.

Only `type`, `subtype`, `is_error`, `num_turns`, `result`, `stop_reason` and `usage` are kept.
`session_id`, `uuid`, `modelUsage`, `total_cost_usd`, timing fields and every `system`,
`assistant` and `rate_limit_event` message are omitted. The raw stream stayed local and is not
committed.
