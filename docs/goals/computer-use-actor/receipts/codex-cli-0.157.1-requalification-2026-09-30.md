# Codex CLI 0.157.1 requalification

Date: 2026-09-30. Scope: the restricted account analyst and the Codex account
participant on Linux x64, with an existing file-backed ChatGPT login, `gpt-6-astra`
and low reasoning effort. The installed CLI was `codex-cli 0.157.1` from npm
`@openai/codex@0.157.1`; its native Linux binary has SHA-256
`3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970`, identical to
a fresh npm install. It joins 0.154.0 in the Linux x64 list of qualified releases;
macOS arm64 keeps 0.154.0 only. The launcher records the detected release in the
execution profile and the analysis identity. The earlier method is in the
[participant receipt](restricted-participant-live-2026-09-23.md), the
[analysis receipt](codex-account-analysis-2026-09-23.md) and the
[launcher contract](../../../architecture/restricted-codex-analysis.md).

`humanish init` writes the try-live lab with `type: local-agent` when Codex is
signed in. Before this change, every host that had updated Codex past 0.154.0
got `HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED` from that lab.

## Release notes read

The GitHub release notes for 0.155.0, 0.155.1, 0.156.0, 0.156.1, 0.157.0 and
0.157.1 were read on 2026-09-30. The 0.157.1 notes are empty; the tag comparison
shows four Windows-only commits over 0.157.0. Changes that touch this boundary:
a `ToolPolicy` refactor of tool restrictions (#46999), agent message-board tools
in the multi-agent namespace, a flag for asynchronous user messages, removal of
`remote_compaction_v2`, automatic daemon startup for interactive sessions
(#47179), and a rewritten collaboration-mode prompt.

## Method and results

Unless stated, each check ran the same harness against both 0.154.0 and 0.157.1,
installed side by side from npm.

| Check | Result |
| --- | --- |
| `app-server generate-json-schema --experimental` | Request and response changes are additive. Thread item types, raw response item types and server request methods are unchanged. Two new notifications carry no thread scope. |
| `codex features list` under the Humanish config | All 29 pinned features exist with the same stage and effective value. New default-on features: `daemon_auto_start`, `realtime_conversation`, `worktrees`, `system_proxy_fallback` and two Guardian settings. |
| Loopback provider: advertised tools | Both advertise `exec`, `wait`, `request_user_input` and `request_user_input_async`. The 0.154.0 run matched the committed inventory fixture exactly. 0.157.1 drops the nested `skills__list` and `skills__read`. |
| Loopback provider: 18 injected tool calls | Identical denials from both. `exec` returns "code-mode host is disabled". Shell, `exec_command`, `apply_patch`, `view_image`, agent spawn, message board, MCP, web search, clock and sleep calls are refused as unsupported. No server request reached the client. |
| Loopback provider: question tools | `request_user_input` is "unavailable in Default mode". The async variant produces an `agentMessage` with `delivery: async`, which the launcher rejects. |
| Loopback provider: participant Code Mode | Both show the same `exec`, one `dynamicToolCall` for `humanish_ui` with a null namespace, and an `item/tool/call` request. From inside `exec`, 0.157.1 exposes only `clock__curr_time` and `humanish_ui`; `process`, `require` and `fetch` are undefined. |
| Account-backed readiness (product launcher, no model turn) | Passed. The userAgent format is unchanged (`humanish_analysis/0.157.1 (…)`). Config and thread admission passed; MCP status is empty. |
| Live analyst turn | Completed with a vision answer that matched the image. 2,219 input and 22 output tokens, usage complete, only message items. |
| Hosted participant, TodoMVC, automatic analysis | Goal reached in 3 turns and 4 actions, confirmed against the final capture. One request: dispatched, usage complete, cleanup confirmed, profile verified; that receipt, not the recorded `cliVersion` alone, shows the launched release passed its checks. The sandbox was killed at teardown, and `humanish verify` passed 16 checks. |
| Participant cancellation during a tool call | `cancelled`, one tool call, none after the abort. Cleanup was confirmed and no spawned process remained. |
| Analyst cancellation after the first streamed delta | `cancelled` 191 ms after the abort, usage incomplete. The private work directory was removed and no recovery marker was written. |

During the hosted study a 1 s watcher saw zero connections from either app-server to
the host's managed daemon socket. That daemon runs 0.159.2 and updates separately
from the npm CLI; its version would fail the userAgent and thread-version checks.
The watcher saw only the Code Mode host as a child, but it sampled too slowly: the
fixed script below traces short-lived startup helpers in every release.

| Request scope | Input tokens | Output tokens | Dollar estimate |
| --- | ---: | ---: | --- |
| Analyst turn | 2,219 | 22 | Unknown |
| Participant, study 2 (one continuing request) | 30,140 (18,560 cached) | 291 | Unknown |
| Automatic analyst, study 1 | 7,100 | 709 | Unknown |
| Automatic analyst, study 2 | 10,976 | 1,193 | Unknown |

The two E2B desktops were estimated at $0.005232 and $0.005896. Retained run IDs:
`codex-0157-participant` and `codex-0157-participant-2`.

## Fixed qualification script

Two reviews of `pnpm codex:qualify` found gaps. The first: the isolate check compared tool
names parsed from descriptions, a failed `ps` counted as no children, one snapshot missed
short-lived processes, any baseline was accepted and every `-wal`/`-shm` file was allowed.
The second: a unix client's connection to a daemon was invisible, because the client socket
is unnamed; sampler read errors became empty lists; file checks saw top-level names of one
scenario; calling a tool with `{}` could not tell a refusal from an input error; execs were
pooled across scenarios; `execveat` lost its directory; and the preparatory commands ran
untraced.

The fixed script runs every invocation of either binary under `strace -f -yy`. It compares
execs, socket operations and file writes per scenario, snapshots the probe's work directory
recursively around each scenario, and runs the live phases for the baseline as well. It
qualifies Linux only. The runs below used `scripts/codex-qualify.mjs` at commit cd400bb3,
which lands separately from the admission change; that script prints its rewrites and
exemptions with every run. With it, `pnpm codex:qualify 0.157.1 --baseline 0.154.0 --live`
passed all 53 checks. Evidence is retained locally in
`.humanish/codex-qualify/0.157.1-r4/evidence.json`.

This is drift evidence: 0.157.1 did nothing in these scenarios that 0.154.0 did not. A third
review of that qualifier found exemptions a release could hide behind (a failed unlink
counted as a removal, sidecar and schema-output paths matched by prefix, unsampled live
remotes). Those are harness gaps, fixed in the qualifier's own change, not behavior observed
in 0.157.1. The qualifier cannot show that a binary built to evade it is safe; see the
[admission rules](../../../architecture/restricted-codex-analysis.md#admitting-a-codex-cli-release).

- Participant isolate, from its own `Object.keys(tools)` and each call's result: 0.154.0
  exposed `clock__curr_time`, `humanish_ui`, `skills__list` and `skills__read`. Its skills
  calls failed with ``missing field `authority` `` and ``missing field `package` ``, which are
  input errors, so the baseline never showed those tools refused. 0.157.1 exposes only
  `clock__curr_time` and `humanish_ui`; the clock call succeeds and fetch is refused.
- Executed programs, per scenario: 0.157.1 runs the same ten execs as 0.154.0 in each
  scenario, argv for argv, with nothing added. They are:
  - `<codex>/bin/codex-code-mode-host`, participant scenarios only;
  - `/usr/bin/bwrap --unshare-user --unshare-net --ro-bind / / /bin/true` and the
    `/bin/true` inside it, a bubblewrap capability probe;
  - `/usr/bin/lsb_release -a`, which runs `getopt --name lsb_release -o hvidrcas -l
    help,version,id,description,release,codename,all,short -- -a`, `cut -c1`, `cut -c2-`,
    `tr [:lower:] [:upper:]` and `tr [:upper:] [:lower:]`;
  - `/usr/bin/getconf LONG_BIT`.

  0.154.0 runs the OS-information helpers three or four times per app-server and 0.157.1
  twice; the comparison is over distinct execs. No exec carried a model-supplied argument,
  and nothing outlived its app-server. The preparatory commands executed nothing else.
- Sockets, per scenario: both releases bind and send on a netlink socket (bubblewrap's
  loopback setup) and connect to the loopback provider, and nothing else. 0.157.1 also sends
  once per scenario between the two ends of a socketpair it created, which stays inside the
  traced tree. The sampler saw TCP only to the loopback provider, no UDP and no unix path.
- Files, per scenario: 0.157.1's traced writes and its added, removed and retyped entries
  stayed within 0.154.0's. 0.154.0 leaves its `tmp/arg0/codex-arg0*` helper directory
  behind; 0.157.1 removes it.
- Live, both releases through the real launcher: each of 0.157.1's eight launches ran the
  same exec set, socket set and file writes as 0.154.0's same launch. TCP went only to
  `<chatgpt.com>:443`, UDP only to the resolver's port 53 and to `<chatgpt.com>` for source
  address selection, and nothing connected to the daemon socket. The four `--version` checks
  executed nothing. The analyst turn used 2,200 input and 22 output tokens with complete
  usage; the analyst, aborted at its first delta, returned `cancelled` 528 ms later; the
  participant was cancelled with one tool call and no later one; each session's private work
  directory was removed. The operator-mode participant created and removed a SQLite
  temporary file under `/var/tmp`, which the exclusive-create exemption covers.

The sampler now treats two cases the earlier script got wrong. A zombie refuses
`/proc/<pid>/fd` with `EACCES` like a live non-dumpable process, so every short-lived child
had briefly looked unreadable; a zombie holds no descriptors and now counts as exited. After
a live launch exited, its root pid could be reused by another process, which the sampler then
followed; it now stops at a changed start time.

Local validation of the per-host rework passed `pnpm release:check` (3,815 core and
87 TUI tests), 384 Observer tests and the four Observer browser proofs. Tests cover
admission of every Linux x64 release and refusal of 0.157.1 on macOS arm64. They also
cover refusal of an initialize userAgent or thread that names another release, and
refusal of a release other than the one an analysis identity recorded. Other tests
check that the detected release reaches the participant profile and the analysis
identity, and that readers keep every recorded release. Tests for the fixed script cover
a hidden callable isolate tool, a failed inspection, an unqualified baseline, an
unrelated `-wal` file, the event multiset, and a grandchild and a detached process. Exec
tests cover an added program, an `argv[0]` or argument change, a truncated argument,
unpaired trace lines and a missing trace. Tests for the second review cover a traced daemon
connection, the listener behind a real unix client, injected `EACCES` reads, a zombie, a
reused root pid, a new file in the escape scenario, a write outside the work directory, a
refusal turned input error, a helper moved between scenarios, `execveat` with two
descriptors and an added exec in `--version`.

## Differences that are not regressions

- The first study asked for the text `Café 日本語 🙂`. Codex proposed the type
  action. The E2B executor's clipboard fallback then failed because the desktop
  has no `xclip` or `xsel`, which is issue #340. Study 2 used ASCII text.
- The 0.157.1 collaboration-mode prompt no longer tells the model to avoid
  `request_user_input`. On a blank-image analyst prompt, the model called `exec`
  in 3 of 6 runs on 0.157.1 and 6 of 6 on 0.154.0. The launcher refused every
  one with `codex_tool_call`. Both automatic analyses and the other analyst turns
  completed.

## Not established

- Apple Silicon on 0.157.1. The Mac checks ran on 0.154.0 only, and `codex:qualify` refuses
  on macOS because it has no `strace`.
- CLI 0.158.0, which was not qualified. 0.159.2 has its own
  [receipt](codex-cli-0.159.2-qualification-2026-09-30.md).
- Binary attestation. Release strings are compatibility checks: a modified binary can
  report any release, and the launcher does not pin executable contents.
- Work a process does without `execve`. The trace records executed programs, not what
  a running process does in-process.
- Whether 0.157.1 thread totals include compaction requests. Compacted turns
  still record incomplete usage.
- Unicode typing on E2B, forced token refresh, keychain logins, and cohort-scale
  reliability.
- The try-live `local-agent` template kept `caps.maxUsd: 2`, which preflight refuses
  with `HUMANISH_CUA_LAB_UNPRICED_CAP`. #973 fixed it separately.
