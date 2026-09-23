# Restricted Codex account analysis

The optional account analyst uses a new Codex app-server process after participant
execution, with a separate conversation, process and tool authority. It can use
the same host Codex login as a local-agent participant. Existing API analysis
remains a separate provider.

The qualified launcher profile is **Codex CLI 0.154.0, Linux x64, file-backed
ChatGPT login, `gpt-6-astra`, low reasoning effort**. Other versions/platforms,
keychain-only logins and API-key Codex logins are refused before a model turn.
Readiness validates the installation and effective profile without submitting a
model turn; it does not guarantee current quota or model access.

## Authority and request limits

The host creates a private temporary Codex home and links only the existing
`auth.json`. Humanish never reads or copies its values. The native CLI owns
authentication and provider network traffic. Its environment excludes provider
keys, target-app variables, alternate endpoints and operator configuration.
The selected native binary is launched directly; npm wrappers are resolved to
their native executable before launch.

Before creating a thread, Humanish checks the effective config. Nonempty system
settings, inherited instructions, MCP, plugins, hooks, alternate stores/endpoints
and unsupported authority are rejected. The thread is ephemeral, has no runtime
environments or workspace roots, and uses only the supplied text/images and
closed output schema. No provider/model fallback is allowed.

This profile is **not advertised as tool-free**. The CLI retains code-mode
descriptions, but the qualified `features.code_mode_host=false` setting rejects
their actual dispatch. `agents.enabled=false` removes delegation; the older
feature toggle alone did not. Humanish also refuses raw tool calls, unexpected
host RPCs and asynchronous question messages before accepting any report. The
actual notification/denial captures and provenance are in
[`tests/fixtures/restricted-codex`](https://github.com/danielgwilson/humanish/blob/46330116726f74080fa18947c36da4fb4b333805/tests/fixtures/restricted-codex/README.md).

Each request owns a separate child process, temporary home and fresh thread;
participant, analyst and readiness requests may run concurrently. An unresolved
child process blocks new requests until its exit is confirmed. Each thread receives
one turn. Evidence is not silently
downselected: at most 128 images, 20 MiB decoded image data, and 32 MiB serialized
request data are admitted. Generated report text is limited to 2 MiB. Raw input
notifications echo image data URLs, so their frame budget is the larger of 2 MiB
or the admitted serialized packet plus 1 MiB; total stdout is bounded separately
at the larger of 8 MiB or twice that frame budget plus 4 MiB. Stderr is bounded at
2 MiB and is not retained. Notifications are limited to 65,536; aggregate
generated assistant-text deltas are independently limited to 2 MiB, regardless
of the input-image wire budget. The request's
deadline includes startup; individual RPCs also have a 15-second ceiling.

Account analysis has unknown dollar cost and no supported generated-token cap.
Numeric output-token caps are rejected. The integration must likewise reject
numeric dollar caps for this provider. Known token usage is retained; missing or
interrupted usage is unknown/partial, not zero. The ordinary analysis validator,
source-integrity checks and narrative secret scrubber remain responsible for
accepting and publishing the report.

## Cancellation and auth recovery

Cancellation interrupts the turn, then closes the directly owned native child
and its stdio with bounded termination/kill waits. No stored PID or process group
is signaled after exit. This proves the direct child's lifecycle, not arbitrary
descendant-tree reclamation; process-spawning tools are outside this profile.
If native closure cannot be confirmed, Humanish preserves its private state and
blocks another session in the same process until that exact child closes.

After confirmed closure, normal cleanup removes the owned auth symlink and
temporary directory. It never deletes or overwrites the operator's original
login. Unexpected replacement of the symlink is different: it might contain
rotated auth state. Humanish preserves that private file with mode 0600 inside a
0700 task home, removes other scratch/evidence, refuses the report, and returns
`codex_cleanup_failed`. It does not copy the replacement into the original
login, which could overwrite a newer concurrent login.

Local recovery markers live under
`$XDG_CACHE_HOME/humanish/codex-analysis-recovery/`, or
`~/.cache/humanish/codex-analysis-recovery/`. A marker contains only the generated
task directory name and fixed file names. Find that same directory under the
system temporary directory (`$TMPDIR` when configured); retained login state is
inside `home/auth.json`. Do not discard a retained replacement before recovering
the login. Run `codex login` before retrying if the persistent login is no longer
usable. Actual private paths and credentials are never included in an analysis
artifact. An unconfirmed-process marker instead means the private directory is
retained until the process lifecycle can be inspected safely.

Qualification used short, existing-login calls; it did not force token refresh.
The available Codex file-store source writes through the auth path, but matching
binary refresh behavior and concurrency with unrelated Codex applications are
not established by that proof. Recovery deliberately fails closed if storage
behaves differently. Keychain/other-platform support and whole-process-tree
leases require their own qualification.
