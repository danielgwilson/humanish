# Local Codex TUI Actor Contract

Date: 2026-06-02

Status: incremental implementation on issue #28. The repo supports one explicit
local Codex TUI actor with sanitized lifecycle evidence and fail-fast Codex
workspace-trust preflight. It also supports explicit noninteractive
`codex-exec` actor fanout from one to four lanes for autonomous local dogfood
proof, including active-run Observer data refresh while exec lanes are running.
TUI trust bootstrap and TUI live Observer follow remain follow-up work.

## Goal

Let `mimetic run` dogfood `mimetic-cli` with a real local Codex TUI actor while
preserving the public-safe harness contract:

```text
spawn actor
-> submit bounded prompt
-> stream sanitized lifecycle events
-> write run bundle
-> render Observer while active
-> verify final bundle
```

This actor proves the local harness substrate. It must not claim target product
behavior beyond the commands and artifacts it actually observes.

## Explicit Opt-In

The first live actor must require an explicit flag or env var. Non-dry-run
without opt-in should continue to fail closed.

Suggested gate:

```bash
mimetic run --actor codex-tui --sims 1 --timeout-ms 120000
```

or, for noninteractive local autonomy:

```bash
mimetic run --actor codex-exec --sims 4 --timeout-ms 120000
```

or:

```bash
MIMETIC_ENABLE_LOCAL_CODEX_TUI=1 mimetic run --sims 1
```

or:

```bash
MIMETIC_ENABLE_LOCAL_CODEX_EXEC=1 mimetic run --sims 1
```

Provider spend, E2B, GitHub mutation, and external network calls remain off
unless separately and explicitly requested.

For deterministic tests or local substrate debugging, `MIMETIC_CODEX_ACTOR_COMMAND`
can point at a safe fixture command. Real Codex TUI launch uses a Linux
`script` PTY wrapper when available because the Codex TUI requires a terminal.
Real Codex exec launch uses `codex exec --skip-git-repo-check --ignore-rules
--ephemeral --sandbox read-only --json` so it can complete without an
interactive TUI trust prompt while still running with read-only local command
permissions.

## Lifecycle Events

The actor should append deterministic events to `events.ndjson`:

| Event | Required fields |
| --- | --- |
| `actor.spawned` | `simId`, `streamId`, command name, cwd, startedAt |
| `actor.prompt.submitted` | prompt digest, prompt class, no raw prompt if unsafe |
| `actor.running` | running snapshot available in `run.json` and `observer/observer-data.json` |
| `actor.observation` | sanitized transcript tail, byte count, redaction status |
| `actor.artifact` | relative artifact path, kind, digest |
| `actor.verdict` | `passed`, `failed`, `blocked`, or `timed_out`; reason |
| `actor.exited` | exit code, signal, durationMs |
| `actor.timeout` | timeoutMs, last safe observation |
| `actor.cancelled` | signal and operator reason |

The Observer should be able to render a live terminal stream from those events
while the actor is active, then render the final transcript and artifacts after
exit.

For `codex-exec`, the run writes a provisional running bundle and
`observer/observer-data.json` before awaiting actor completion, then refreshes
those files with final lane verdicts and artifact links. This lets an existing
served Observer poll the same local evidence path during the run.

## Runtime State

All generated state stays under ignored `.mimetic/`:

```text
.mimetic/runs/<run-id>/
  run.json
  review.json
  review.md
  events.ndjson
  actor.json
  actors/sim-02-codex-exec.json
  transcripts/codex-tui-sanitized.txt
  transcripts/codex-exec-sanitized.jsonl
  transcripts/sim-02-codex-exec-sanitized.jsonl
  observer/
    index.html
    observer-data.json
```

No raw terminal output is public by default. The transcript artifact must be
sanitized before it is linked from the bundle.

## Redaction Rules

Before any transcript tail or event payload is written:

- redact OpenAI, E2B, GitHub, npm, and generic private-key patterns;
- redact absolute local home/workspace paths when they are not necessary for
  proof;
- block the run if redaction cannot prove `status: passed`;
- record env var names only, never values.

## Initial Prompt Class

The first actor prompt should be bounded to public-safe dogfood work:

- inspect `mimetic/` dogfood config;
- run `pnpm mimetic -- doctor`;
- run or explain the strongest safe Mimetic proof command available;
- do not commit, push, publish, file issues, or print secrets;
- summarize blockers using public-safe evidence paths.

The raw prompt can live in source only if it contains no private context and no
credential values.

## Stop Conditions

The actor must stop and mark the lane `blocked` or `failed` if:

- Codex CLI is not installed or not authenticated;
- a command requests approval in a non-interactive run;
- redaction fails;
- output contains a likely secret after redaction;
- the actor touches files outside allowed runtime paths without explicit scope;
- timeout is reached.

## Known First-Slice Boundary

The first real local TUI proof in this environment reached Codex's workspace
trust prompt. The current TUI implementation detects that state before spawn
and writes a `blocked` run bundle instead of waiting for the TUI timeout. The
resulting bundle is still verifiable and Observer-renderable, but it does not
prove autonomous TUI completion until the trust root is explicitly approved.

The noninteractive `codex-exec` mode is a separate actor contract for autonomous
local completion. It can run up to four bounded read-only lanes with distinct
focuses across install readability, public safety, Observer evidence, and
verification/release gates. It does not replace the TUI contract because it does
not prove PTY rendering, keyboard focus, or visible live TUI observation.

The next implementation slice should add an explicit, public-safe trust
bootstrap before spawning the TUI. Acceptable fixes include:

- allow an explicit operator-approved trust bootstrap for this repository only;
- keep the existing `codex-exec` 4x fanout path as the autonomous fallback while
  TUI trust remains blocked.

## Acceptance For First Slice

The implementation slice for this spec should prove:

```bash
pnpm mimetic:doctor
pnpm mimetic -- run --actor codex-tui --sims 1 --timeout-ms 120000 --json
pnpm mimetic -- run --actor codex-exec --sims 1 --timeout-ms 120000 --json
pnpm mimetic -- run --actor codex-exec --sims 4 --timeout-ms 120000 --json
pnpm mimetic -- watch --run latest --detach --json --no-open
pnpm mimetic -- verify --run latest --json
pnpm check
```
