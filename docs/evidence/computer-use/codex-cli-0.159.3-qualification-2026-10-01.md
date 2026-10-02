# Codex CLI 0.159.3 qualification

Date: 2026-10-01. Scope: the restricted account analyst and the Codex account participant on
Linux x64, with an existing file-backed ChatGPT login, `gpt-6-astra` and low reasoning effort.
The candidate was npm `@openai/codex@0.159.3`, npm's `latest` on that date. Its native Linux
binary has SHA-256 `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`, the same
binary as this host's global install. The baseline was 0.159.2
([receipt](codex-cli-0.159.2-qualification-2026-09-30.md)), the newest release qualified on the
host. No 0.159.4 or newer stable release existed; 0.161.0 was published as alpha builds only.
0.159.3 joins 0.154.0, 0.157.1 and 0.159.2 in the Linux x64 list; macOS keeps 0.154.0 only.

## Release notes read

The GitHub release notes for 0.159.3 (2026-09-30) were read on 2026-10-01. The release has one
change, a backport (openai/codex#49744): eligible ChatGPT-signed-in local sessions can show
optional reminders to complete account security setup. All 23 changed files are under
`codex-rs/tui/`, the interactive terminal UI. Nothing changed in the app-server the launcher
drives, its protocol or its tools.

## Method and results

`pnpm codex:qualify 0.159.3 --live` used `scripts/codex-qualify.mjs` at main b9c0e294 and
passed all 56 of its checks against 0.159.2.

| Check | Result |
| --- | --- |
| App-server schema | Thread item, raw response item and server request types unchanged. No new notifications and no changed launcher-facing protocol files. |
| Feature flags | All pinned features keep their stage and value in the analyst and participant configs. No newly enabled features. |
| Preparatory commands | `--version`, schema generation and both feature listings executed nothing and stayed within 0.159.2's sockets and file writes. |
| Loopback probes | The same four advertised tools, one advertised nested Code Mode tool (`clock__curr_time`) and the same denials for all injected calls. Question outputs and the question-event multiset match, as do the participant Code Mode lifecycle and the developer instructions. The participant isolate's tool keys are `clock__curr_time` and `humanish_ui`; only the clock call succeeds; `process`, `require`, `fetch` and `Deno` are undefined; and fetch is refused. |
| Executed programs | No added exec in any scenario: the same helpers as 0.159.2, argv for argv (the Code Mode host, the bubblewrap capability probe, `lsb_release -a` with `getopt`, `cut` and `tr`, and `getconf LONG_BIT`). No exec carried a model-supplied argument, and nothing outlived its app-server. |
| Sockets and files | Per scenario, the same operations as 0.159.2: TCP only to the loopback provider and one send inside a socketpair the traced tree created. No io_uring. Traced writes and work-directory snapshot entries stayed within 0.159.2's. |
| Live, launcher with the candidate binary | Readiness passed without a turn. The analyst turn completed with the expected answer and complete usage (2,200 input, 22 output tokens). The analyst, aborted at its first delta, returned `cancelled` 129 ms later and removed its private directory. The participant, cancelled during its first tool call, admitted no later call, confirmed cleanup and reported `cliVersion: 0.159.3`. Each of the four live launches (readiness, analyst turn, analyst cancellation, participant cancellation) matched 0.159.2's same launch for execs, sockets and file writes. TCP and UDP went only to `<chatgpt.com>` and the resolver, and nothing connected to a Codex daemon socket. |
| Hosted participant study, `try-live` | See below. |

### Hosted participant study

A fresh project installed the packed branch head (with 0.159.3 admitted) and `@e2b/desktop`
2.4.0. `humanish init --yes`, run without a provider key, wrote `try-live` with
`type: local-agent, localAgent: codex`. The study added `review.analysis.provider: codex` so the
automatic analysis would run on the Codex account, and set `defaults.open: false`. It ran with
an env file holding only `E2B_API_KEY`; `OPENAI_API_KEY` and `CODEX_API_KEY` were unset, so the
participant stayed on ChatGPT-account billing. The global `codex` on `PATH` was the qualified
binary.

- `npx humanish run try-live` (run `cua-2026-10-01T20-23-28-165Z-986c7ba6`): the participant,
  on a commit-pinned drawDB clone, reported reaching the goal (`goal_satisfied`) in 8 turns and
  14 actions. The final capture shows "Tables (2)" with tables named `customers` and `orders`,
  which confirms the report.
- One provider request: dispatched, usage complete, cleanup confirmed, profile verified. The
  execution profile records `cliVersion: 0.159.3`. The verified request receipt shows the
  launch passed the launcher's release checks; the recorded release alone would not.
- The automatic Codex analysis completed (3 findings). Its identity records
  `cliVersion: 0.159.3`, and its job completed against the bound claim.
- `humanish verify --run <id>` passed 16 of 16 checks; share safety is `local_only` (raw
  screenshots).
- `humanish reclaim` found the one journaled sandbox already gone.

| Request scope | Input tokens | Output tokens | Dollar estimate |
| --- | ---: | ---: | --- |
| Live analyst turn (qualifier) | 2,200 | 22 | Unknown |
| Hosted participant (one continuing request) | 102,485 (84,224 cached) | 656 | Unknown |
| Automatic analyst | 21,161 | 1,983 | Unknown |

Retained locally: evidence `.humanish/codex-qualify/0.159.3-live/evidence.json` and the
`try-live` run.

## Not established

- macOS on 0.159.3. `codex:qualify` refuses on macOS because it has no `strace`.
- The security-setup reminder itself. It is a TUI feature, and the launcher does not run the
  TUI.
- Unicode typing on E2B (#340), forced token refresh and keychain logins.
- Binary attestation. Release strings are compatibility checks: a modified binary can report
  any release, and the launcher does not pin executable contents.
- Work a process does without `execve`, and the qualifier's other named limits
  ([the qualifier](../../architecture/restricted-codex-analysis.md#the-qualifier)).
