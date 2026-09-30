# Codex CLI 0.159.2 qualification

Date: 2026-09-30. Scope: the restricted account analyst and the Codex account
participant on Linux x64, with an existing file-backed ChatGPT login, `gpt-6-astra`
and low reasoning effort. The candidate was npm `@openai/codex@0.159.2`; its native
Linux binary has SHA-256
`1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`, identical to
the release this host's managed Codex daemon had already updated to. 0.159.2 joins
0.154.0 and 0.157.1 in the Linux x64 list; macOS keeps 0.154.0 only. It was the first
release run through `pnpm codex:qualify`. The first script used 0.157.1
([receipt](codex-cli-0.157.1-requalification-2026-09-30.md)) as the baseline; the fixed
script's qualifying run used 0.154.0.

## Release notes read

The GitHub release notes for 0.158.0, 0.159.0, 0.159.1 and 0.159.2 were read on
2026-09-30. Changes near this boundary: terminal input approval is on by default
(`write_stdin_approval`), local threads default to paginated history, an opt-in
`instant_interrupt` lets new input steer running Code Mode calls, and 0.159.1 makes
GPT-6.1 Sol the bundled default model. 0.159.1 and 0.159.2 are backports.

## Method and results

The first `pnpm codex:qualify 0.159.2 --live` passed all 26 of its checks. Reviews then
found gaps in that script (see the fixed-script section below), and the fixed script passed
all 53 of its checks with 0.154.0 as the baseline. The table merges both runs.

| Check | Result |
| --- | --- |
| App-server schema | Thread item, raw response item and server request types are unchanged, and there are no new notifications. Five launcher-facing files changed additively: a `promax` plan type, turn error codes `flexUnavailable` and `tooManyDenials`, and interrupted turns may now carry `error`. The launcher tests `interrupted` before it reads `error`. |
| Feature flags | All pinned features keep their stage and value. `write_stdin_approval` is newly enabled; it gates shell stdin, and shell tools are denied in both profiles. |
| Loopback probes | Same four advertised tools, one advertised nested Code Mode tool (`clock__curr_time`) and 18 identical denials. Question outputs and the question-event multiset match, as do the participant Code Mode lifecycle and the developer instructions. The participant isolate's own tool keys are `clock__curr_time` and `humanish_ui`, only the clock call succeeds, `process`, `require`, `fetch` and `Deno` are undefined, and fetch is refused. |
| Live, launcher with the candidate binary | Readiness passed without a turn. The analyst turn completed with the expected answer and complete usage. The analyst, aborted at its first delta, returned `cancelled` 40 ms later and removed its private directory. The participant, cancelled during its first tool call, admitted no later call, confirmed cleanup and reported `cliVersion: 0.159.2`. |
| Hosted participant study, TodoMVC | Goal reached in 3 turns and 3 actions, confirmed against the final capture. One request: dispatched, usage complete, cleanup confirmed, profile verified. The execution profile records `cliVersion: 0.159.2`; the verified request receipt, not the recorded release alone, shows it passed the launch checks. The automatic Codex analysis recorded identity `cliVersion: 0.159.2`, and its job completed against the bound claim. `humanish verify` passed. |

During the hosted study a 1 s watcher saw zero connections from either app-server to the
host's managed daemon socket. It saw only the Code Mode host as a child, but it sampled too
slowly for the startup helpers the fixed script traces. Product readiness also passed
against the real 0.154.0, 0.157.1 and 0.159.2 binaries, and each was detected as itself.

| Request scope | Input tokens | Output tokens | Dollar estimate |
| --- | ---: | ---: | --- |
| Live analyst turn | 2,200 | 22 | Unknown |
| Hosted participant (one continuing request) | 30,108 (18,560 cached) | 286 | Unknown |
| Automatic analyst | 10,910 | 1,155 | Unknown |

Retained locally: evidence `.humanish/codex-qualify/0.159.2-live/evidence.json` (first
script) and `.humanish/codex-qualify/0.159.2-r4/evidence.json` (fixed script), and run
`codex-0159-participant`.

The first offline run failed two checks that turned out to be harness strictness. In one
0.159.2 run, the async-question output arrived after its `agentMessage` item instead of
before it. The live run showed the original order, and the launcher rejects the first
offending event either way. SQLite `-shm`/`-wal` sidecar files also appear or not with
checkpoint timing. The question check now compares a sorted event multiset, so each event
still counts, and lists the order for review. The sidecar exception names the known
databases (`goals_1`, `logs_2`, `memories_1`, `queue_1`, `state_5`); any other new file fails.

## Fixed qualification script

Two reviews found gaps in the first script; the
[0.157.1 receipt](codex-cli-0.157.1-requalification-2026-09-30.md#fixed-qualification-script)
lists them. The fixed script runs every invocation of either binary under `strace -f -yy`,
compares execs, socket operations and file writes per scenario, snapshots the work
directory around each scenario and runs the live phases for the baseline as well. It
qualifies Linux only. The runs used `scripts/codex-qualify.mjs` at commit cd400bb3, which
lands separately from the admission change. With it,
`pnpm codex:qualify 0.159.2 --baseline 0.154.0 --live` passed all 53 checks. Evidence is
retained locally in `.humanish/codex-qualify/0.159.2-r4/evidence.json`. As for 0.157.1, this
is drift evidence against a vendor release, not proof against an adversarial binary, and the
harness gaps a later review found are fixed in the qualifier's own change.

- Participant isolate: 0.159.2 exposes only `clock__curr_time` and `humanish_ui`; the clock
  call succeeds and fetch is refused. 0.154.0's `skills__list` and `skills__read` failed
  `{}` with input errors, so the baseline never showed them refused; 0.159.2 does not
  expose them.
- Executed programs, per scenario: the same ten execs as 0.154.0 in each scenario, argv for
  argv, as listed in the 0.157.1 receipt. No exec carried a model-supplied argument, and
  nothing outlived its app-server. The preparatory commands executed nothing else.
- Sockets and files, per scenario: the same netlink and loopback-provider operations as
  0.154.0, plus one send per scenario inside a socketpair it created. Traced writes and
  snapshot entries stayed within 0.154.0's.
- Live: each of the eight launches matched 0.154.0's same launch for execs, sockets and file
  writes. TCP went only to `<chatgpt.com>:443`, UDP only to the resolver and to
  `<chatgpt.com>` for source address selection, and nothing connected to the daemon socket.
  The analyst turn used 2,200 input and 22 output tokens with complete usage; the analyst,
  aborted at its first delta, returned `cancelled` 593 ms later; the participant was
  cancelled with one tool call and no later one; each session's private work directory was
  removed.

An earlier run of the first fixed script failed its temp-directory check, which then counted
every `humanish-codex-analysis-*` entry in the shared temporary directory: 4 before, 5
after. Test suites in other worktrees create and remove that prefix, and they were running
at the time. The check now follows each launch's own work directory.

## Not established

- macOS on 0.159.2. `codex:qualify` refuses on macOS because it has no `strace`.
- CLI 0.158.0, which was not qualified separately.
- Whether 0.159.2 thread totals include compaction requests. Compacted turns still record
  incomplete usage.
- Unicode typing on E2B (#340), forced token refresh and keychain logins.
- Binary attestation. Release strings are compatibility checks: a modified binary can
  report any release, and the launcher does not pin executable contents.
- Work a process does without `execve`. The trace records executed programs, not what a
  running process does in-process.
