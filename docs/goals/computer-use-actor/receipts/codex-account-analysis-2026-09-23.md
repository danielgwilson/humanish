# Codex account analysis qualification

Date: 2026-09-23. Scope: explicitly selected study analysis, using Codex CLI
0.154.0 on Linux x64 with an existing file-backed ChatGPT login and
`gpt-6-astra` at low reasoning effort. Participant execution remained hosted.
This does not qualify a local desktop runtime, other platforms or CLI versions.

## Retained studies

Each synthetic study gave two actual model participants the same note-saving
task. One page displayed an error after each Save attempt; the control page
displayed Saved. Independent page reads checked these outcomes. The task and
pages contained no customer data.

| Run | Observation |
| --- | --- |
| `cua-2026-09-23T08-15-16-485Z-b0762e87` | Manual account analysis reviewed 25 evidence entries and seven screenshots; it classified the error participant as blocked and the control as completed. |
| `cua-2026-09-23T08-56-15-516Z-b4df5a00` | The recording producer automatically invoked the selected account analyst after both desktops were independently confirmed absent. The report and durable automatic job completed. |
| `cua-2026-09-23T09-01-34-056Z-a797cd33` | A fresh replication again completed automatic analysis after desktop cleanup. The direct Node process exited naturally with no active resources reported at `beforeExit`. |

The first automatic proof wrapper returned signal exit 143 after saving its
successful assertions and report. Its termination cause was not established.
The diagnostic replication observed no parent SIGTERM and exited zero; natural
process exit is established by that replication, not inferred from the first
report's completion.

The three studies' participant/desktop estimates were $0.062705, $0.062639 and
$0.053616. These exclude account analysis. Account dollar usage remains unknown;
it must not be presented as free or priced using API rates.

## Analysis and review checks

- The manual report passed the existing evidence/reference validator, including
  visual claims bound to supplied captures. Its complete token observation was
  15,745 input and 1,570 output tokens.
- Repeating the identical request reused the report without invoking the
  provider. The built CLI also returned that same cached version with API keys
  absent. Repeating the completed automatic claim did not dispatch another turn.
- Cancelling an explicit rerun after a real output delta produced a cancelled
  receipt with incomplete usage. Both native children closed, owned temporary
  directories were removed, and the earlier valid report remained readable and
  reusable. The measured interval from cancellation to the completed service
  result was 1,327 ms.
- Desktop and 390-pixel Observer review checked the actual report, account
  methodology, unknown-dollar disclosure, visual and statement citations, and
  return-to-finding focus. The displayed capture's SHA-256 matched its evidence
  entry. No horizontal page overflow or browser exceptions were observed.
- The first larger report exhausted an initial 1,000-notification allowance.
  That failed attempt remains recorded with unknown usage. The corrected
  bounded transport accepted the later report's 1,560 text deltas; regression
  tests separately limit generated UTF-8 text to 2 MiB even with large image
  echoes. This was an explicit retry, not an automatic provider fallback.

Local validation passed `release:check` (3,324 core and 86 TUI tests), 362
Observer tests, the Observer browser harness, generated CLI docs, public-surface
scan, and site typecheck/build/registry checks. Independent launcher review ran
75 focused regressions after resolving its config, protocol and process-ownership
findings. The source fixture for streamed text was then checked against the real
report notification and its 56 session tests rerun successfully.

This proof uses short existing-login sessions. It does not force credential
refresh, prove coordination with unrelated Codex applications, establish model
access for another account, or establish whole-process-tree isolation. The
launcher owns its direct native child; the qualified tool policy excludes host
execution and delegation. See the [launcher contract](../../../architecture/restricted-codex-analysis.md).
