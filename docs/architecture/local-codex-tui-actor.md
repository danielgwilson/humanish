# Local Codex TUI Actor Contract

Date: 2026-06-02

Status: incremental implementation on issue #28. The repo supports one explicit
local Codex TUI actor with sanitized lifecycle evidence and fail-fast Codex
workspace-trust preflight. It also supports explicit noninteractive
`codex-exec` actor fanout for autonomous local dogfood proof. Requested exec
lanes are not capped by total run count; they run through bounded concurrency
controlled by `HOMUN_LOCAL_CODEX_EXEC_MAX_CONCURRENCY` (default 4). TUI
autonomous completion and TUI live Observer follow remain follow-up work.

## Goal

Let `homun run` dogfood `homun` with a real local Codex TUI actor while
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
homun run --actor codex-tui --sims 1 --timeout-ms 240000
```

or, for noninteractive local autonomy:

```bash
homun run --actor codex-exec --sims 4 --timeout-ms 240000
```

or:

```bash
HOMUN_ENABLE_LOCAL_CODEX_TUI=1 homun run --sims 1
```

or:

```bash
HOMUN_ENABLE_LOCAL_CODEX_EXEC=1 homun run --sims 1
```

Provider spend, E2B, GitHub mutation, and external network calls remain off
unless separately and explicitly requested. When real Codex exec auth is used,
`HOMUN_LOCAL_CODEX_EXEC_MAX_CONCURRENCY` is the cost/resource rail; there is
no arbitrary total lane cap.

For deterministic tests or local substrate debugging, `HOMUN_CODEX_ACTOR_COMMAND`
can point at a safe fixture command. Real Codex TUI launch uses a Linux
`script` PTY wrapper when available because the Codex TUI requires a terminal.
Homun answers the minimal terminal cursor/color queries needed for headless
TUI startup and normalizes terminal control sequences before classifying the
final actor transcript. Once a final
`HOMUN_ACTOR_VERDICT=* HOMUN_ACTOR_NONCE=<run-nonce>` marker appears,
Homun terminates the local actor process and records the marker verdict rather
than waiting for the TUI session to stay open until timeout. The nonce prevents
the classifier from accepting an echoed prompt or inspected docs as a final
actor verdict.
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

For local Codex actors, the run writes a provisional running bundle and
`observer/observer-data.json` before awaiting actor completion, then refreshes
those files with final verdicts and artifact links. This lets an existing
served Observer poll the same local evidence path during the run.

## Runtime State

All generated state stays under ignored `.homun/`:

```text
.homun/runs/<run-id>/
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

For TUI runs, `.homun/runs/latest.json` is published only after a valid
running bundle, review, and Observer data exist, then refreshed after final
artifacts exist. This keeps `homun verify --run latest` from pointing at an
incomplete TUI run while still allowing live Observer follow on the active run.

## Redaction Rules

Before any transcript tail or event payload is written:

- redact OpenAI, E2B, GitHub, npm, and generic private-key patterns;
- redact absolute local home/workspace paths when they are not necessary for
  proof;
- block the run if redaction cannot prove `status: passed`;
- record env var names only, never values.

## Initial Prompt Class

The first actor prompt should be bounded to public-safe dogfood work:

- inspect `homun/` dogfood config;
- run at most two read-only inspection commands;
- avoid commands that write runtime artifacts or temp config, including
  `pnpm homun`, `homun watch`, `homun feedback`, `homun init`, tests,
  builds, installs, and commands that write `.homun/`;
- inspect existing artifacts and explain the strongest write-required proof as a
  follow-up when the TUI actor is running in a read-only sandbox;
- use `passed` when read-only inspection confirms the committed harness and
  existing evidence contract; write-required follow-ups alone are not blockers;
- do not commit, push, publish, file issues, or print secrets;
- summarize blockers using public-safe evidence paths;
- finish with exactly one final
  `HOMUN_ACTOR_VERDICT=<status> HOMUN_ACTOR_NONCE=<run-nonce>` line, where
  `<status>` is `passed`, `blocked`, or `failed`.

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
trust prompt. The current TUI implementation detects missing exact project-root
trust before spawn and writes a `blocked` run bundle instead of waiting for the
TUI timeout. A follow-up PTY probe showed that the Codex TUI still prompts when
only a trusted ancestor is configured, so Homun only treats the exact trust
root as sufficient for autonomous launch.

With exact trust present, Homun answers Codex's terminal startup query, strips
TUI control sequences from the captured transcript, and terminates/classifies on
an explicit nonce-bearing `HOMUN_ACTOR_VERDICT=*` marker when present. If
Codex exits cleanly without a marker, the run is still considered process-passed
but the transcript remains available for review.

The noninteractive `codex-exec` mode is a separate actor contract for autonomous
local completion. It can run requested bounded read-only lanes with distinct
focuses across install readability, public safety, Observer evidence, and
verification/release gates. It does not replace the TUI contract because it does
not prove PTY rendering, keyboard focus, or visible live TUI observation.

The next implementation slice should decide whether TUI-specific fanout is
needed beyond the current 1x TUI proof plus bounded-concurrency noninteractive
`codex-exec` fanout split.

## Acceptance For First Slice

The implementation slice for this spec should prove:

```bash
pnpm homun:doctor
pnpm homun -- run --actor codex-tui --sims 1 --timeout-ms 240000 --json
pnpm homun -- run --actor codex-exec --sims 1 --timeout-ms 240000 --json
pnpm homun -- run --actor codex-exec --sims 4 --timeout-ms 240000 --json
pnpm homun -- watch --run latest --detach --json --no-open
pnpm homun -- verify --run latest --json
pnpm check
```
