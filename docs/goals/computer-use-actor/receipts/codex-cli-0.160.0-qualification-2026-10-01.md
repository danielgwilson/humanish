# Codex CLI 0.160.0 qualification

Date: 2026-10-01. Scope: the restricted account analyst and the Codex account participant on
Linux x64, with an existing file-backed ChatGPT login, `gpt-6-astra` and low reasoning effort.
The candidate was npm `@openai/codex@0.160.0`, npm's `latest` since 2026-10-01 20:26 UTC. Its
native Linux binary has SHA-256
`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`. The baseline was 0.159.3
([receipt](codex-cli-0.159.3-qualification-2026-10-01.md)), the newest release qualified on the
host. 0.160.0 joins 0.154.0, 0.157.1, 0.159.2 and 0.159.3 in the Linux x64 list; macOS keeps
0.154.0 only.

## Release notes read

The GitHub release notes for 0.160.0 (2026-10-01, compared against 0.159.0, 56 commits and 300
files from 0.159.3) were read on 2026-10-01, looking first at the app-server protocol, its
schema and authentication:

- `codex-rs/app-server-protocol` has no changes. The app-server changes are internal:
  stderr span logging drops enter and exit records (#49032) and running turns are counted
  incrementally (#49084).
- Authentication: `login/src/auth/external_bearer.rs` starts a provider auth command as a
  background process (#49164), a Windows console change. ChatGPT sign-in copy changed (#49031).
- Turn errors: a new internal `ContentFilter` error retries a sampling request after recording
  developer guidance in the conversation (#49119, #49130). Model catalogs can carry that
  guidance (`content_filter_guidance`), and explicit provider catalogs are authoritative
  (#49135).
- Features: `guardian_root_handoff_context` and `guardian_conversation_history_tools` are new,
  `UnderDevelopment` and off by default (#49036, #49057). Guardian is the opt-in auto-review.
- The rest is the TUI, Windows sandboxing, SQLite stalls, plugin caching and subagents.

## Method and results

`pnpm codex:qualify 0.160.0 --live` used `scripts/codex-qualify.mjs` at main d2d02ea9 and passed
all 56 of its checks against 0.159.3.

| Check | Result |
| --- | --- |
| App-server schema | Thread item, raw response item and server request types unchanged. No new notifications and no changed launcher-facing protocol files. |
| Feature flags | All pinned features keep their stage and value in the analyst and participant configs. No newly enabled features. |
| Preparatory commands | `--version`, schema generation and both feature listings executed nothing and stayed within 0.159.3's sockets and file writes. |
| Loopback probes | The same four advertised tools, one advertised nested Code Mode tool (`clock__curr_time`) and the same denials for every injected call. Question outputs and the question-event multiset match, as do the participant Code Mode lifecycle and the developer instructions. The participant isolate's tool keys are `clock__curr_time` and `humanish_ui`; only the clock call succeeds; `process`, `require`, `fetch` and `Deno` are undefined; and fetch is refused. |
| Executed programs | No added exec in any scenario: the same helpers as 0.159.3, argv for argv. No exec carried a model-supplied argument, and nothing outlived its app-server. |
| Sockets and files | Per scenario, the same operations as 0.159.3: TCP only to the loopback provider and one send inside a socketpair the traced tree created. No io_uring. Traced writes and work-directory snapshot entries stayed within 0.159.3's. |
| Live, launcher with the candidate binary | Readiness passed without a turn. The analyst turn completed with the expected answer and complete usage (2,201 input, 22 output tokens). The analyst, aborted at its first delta, returned `cancelled` 123 ms later and removed its private directory. The participant, cancelled during its first tool call, admitted no later call, confirmed cleanup and reported `cliVersion: 0.160.0`. Each of the four live launches (readiness, analyst turn, analyst cancellation, participant cancellation) matched 0.159.3's same launch for execs, sockets and file writes. TCP and UDP went only to `<chatgpt.com>` and the resolver, and nothing connected to a Codex daemon socket. |
| Hosted participant study, `try-live` | See below. |

### Hosted participant study

A fresh project installed a packed build of main d2d02ea9 with 0.160.0 added to the three
lists, and `@e2b/desktop` 2.4.0. Every command ran with
`PATH=<evidence>/npm-0.160.0/node_modules/.bin:$PATH`, and `codex --version` there reported
0.160.0. `humanish init --yes`, run without a provider key, wrote `try-live` with
`type: local-agent, localAgent: codex`. The study added `review.analysis.provider: codex` so
the automatic analysis would run on the Codex account, and set `defaults.open: false`. It ran
with an env file holding only `E2B_API_KEY`; `OPENAI_API_KEY` and `CODEX_API_KEY` were unset, so
the participant stayed on ChatGPT-account billing.

- `npx humanish run try-live` (run `cua-2026-10-01T21-14-34-502Z-2fe278a1`): the participant,
  on a commit-pinned drawDB clone, reported reaching the goal (`goal_satisfied`) in 8 turns and
  14 actions. The final capture shows "Tables (2)" with tables named `customers` and `orders`,
  which confirms the report.
- One provider request: dispatched, usage complete, cleanup confirmed, profile verified. The
  execution profile records `cliVersion: 0.160.0`. The verified request receipt shows the
  launch passed the launcher's release checks; the recorded release alone would not.
- The automatic Codex analysis completed (3 findings). Its identity records
  `cliVersion: 0.160.0`, and its job completed against its claim.
- `humanish verify --run <id>` passed 16 of 16 checks; share safety is `local_only` (raw
  screenshots).
- `humanish reclaim` found the one journaled sandbox already gone.

| Request scope | Input tokens | Output tokens | Dollar estimate |
| --- | ---: | ---: | --- |
| Live analyst turn (qualifier) | 2,201 | 22 | Unknown |
| Hosted participant (one continuing request) | 102,504 (84,224 cached) | 653 | Unknown |
| Automatic analyst | 21,140 | 2,011 | Unknown |

Retained locally: evidence `.humanish/codex-qualify/0.160.0-live/evidence.json` and the
`try-live` run.

## Not verified

- macOS arm64. npm ships `@openai/codex@0.160.0-darwin-arm64`, but this host is Linux x64, and
  `codex:qualify` refuses on macOS because it has no `strace`. Apple Silicon stays at 0.154.0.
- The content-filter retry. Neither the probes nor the study hit a content filter, so the
  guidance Codex now records before retrying, and how the launcher treats it, were not seen.
- The Guardian features. They are off by default and the launcher does not enable auto-review.
- Unicode typing on E2B (#340), forced token refresh and keychain logins.
- Binary attestation. Release strings are compatibility checks: a modified binary can report
  any release, and the launcher does not pin executable contents.
- Work a process does without `execve`, and the qualifier's other named limits
  ([the qualifier](../../../architecture/restricted-codex-analysis.md#the-qualifier)).
