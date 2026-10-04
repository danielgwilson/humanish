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

## Interrupted turn

`interrupted-turn.ndjson` comes from a second Claude Code 2.1.285 session on 2026-09-30, spawned
with the same arguments plus `--model haiku`. It sent a user message with `uuid`
`11111111-…`, asking for a long synthetic list, then an `interrupt` control request
(`{ "type": "control_request", "request_id": "int-1", "request": { "subtype": "interrupt",
"cancel_queued": true } }`) three seconds later, then a second user message with `uuid`
`22222222-…`. It keeps, in order:
- the `system` `init` message's `capabilities` (it lists `interrupt_receipt_v1` and
  `interrupt_cancel_queued_v1`) and `claude_code_version`;
- the interrupt's `control_response` receipt;
- the interrupted turn's `result`: `subtype` `error_during_execution`, `is_error: true`, and
  `user_message_uuid` naming the first message;
- the second turn's `result`, naming the second message.

Every other field and message is omitted. The raw stream stayed local.

## Restricted participant and a denied Read

`restricted-denial.ndjson` comes from one Claude Code 2.1.289 session on 2026-10-04, spawned with
the participant flags in `src/actors/local-agent/claude-participant.ts` (`--restricted --tools Read
--strict-mcp-config --permission-mode dontAsk --no-session-persistence`), the participant
environment, and a `--settings` that allowed `Bash(*)`, `Read(//**)` and `Write(//**)`. The
synthetic prompt asked for a Read of an image in the working directory, a Read of a file outside
it, a Bash command and a Write. It keeps, in order:
- the `system` `init` message's `tools`, `mcp_servers`, `permissionMode` and
  `claude_code_version`;
- the two `Read` `tool_use` blocks (the one inside the folder ran; the one outside was denied);
- the `system` `permission_denied` message for the outside Read;
- the `result`'s `type`, `subtype`, `is_error` and `permission_denials`.

The model reported that Bash and Write did not exist; no tool call for either was made. Both paths
are replaced with synthetic ones (`/tmp/humanish-claude-session-AbC123`, `/tmp/outside`). Every
other field and message is omitted.
