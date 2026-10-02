# Restricted Codex account analysis

The optional account analyst uses a new Codex app-server process after participant
execution, with a separate conversation, process and tool authority. It can use
the same host Codex login as a local-agent participant. Existing API analysis
remains a separate provider.

The qualified launcher profile is **a qualified Codex CLI release for the host, Linux x64
or Apple Silicon macOS, file-backed ChatGPT login, `gpt-6-astra`, low reasoning effort**.
Qualified releases are listed per host in
[`src/actors/codex/qualified-versions.ts`](https://github.com/danielgwilson/humanish/blob/main/src/actors/codex/qualified-versions.ts).
Linux x64 accepts 0.154.0, 0.157.1
([receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/codex-cli-0.157.1-requalification-2026-09-30.md))
0.159.2
([receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/codex-cli-0.159.2-qualification-2026-09-30.md))
0.159.3
([receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/codex-cli-0.159.3-qualification-2026-10-01.md))
and 0.160.0
([receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/codex-cli-0.160.0-qualification-2026-10-01.md)).
Apple Silicon accepts 0.154.0, which passed installed participant/analysis studies and the
native dispatch restriction check on an M5 Max; later releases need the same check on a Mac.
Hosted participants on Linux arm64 and Intel macOS keep 0.154.0 as a pre-existing admission,
listed separately in `PREEXISTING_CODEX_CLI_ADMISSIONS`: it is what they ran before per-host
lists existed, not a qualification, and no later release is admitted there. Other releases and
platforms, keychain-only logins and API-key Codex logins are refused before a model turn.

A release string is a compatibility check, not binary attestation. The launcher compares the
release that `codex --version`, initialize and thread start report, then executes the same
path; it does not pin the executable's contents, and a modified binary can report any release.
The launcher records the detected release in the participant execution profile and in the
analysis identity. A recorded release alone is not execution proof: prelaunch and failed
attempts can carry the declared default, and a request's `dispatched` and `profileVerified`
receipt shows that the launched release passed its checks. Saved bundles naming any recorded
release stay readable.
Readiness validates the installation and effective profile without submitting a
model turn; it does not guarantee current quota or model access.

Each launch also checks the release's app-server schema. After `--version`, the launcher runs
`codex app-server generate-json-schema --experimental` into its private work directory, bounded
at 15 seconds and 64 KiB of output, and removes the schema after reading it.
[`src/actors/codex/protocol-contract.ts`](https://github.com/danielgwilson/humanish/blob/main/src/actors/codex/protocol-contract.ts)
lists each method humanish calls with the params fields it sends and the response fields it reads,
and each notification and server request it consumes. The schema does not link a response to its
method, so the table names each response definition. A field humanish reads that is gone or
allows another type, a value humanish compares against that the release dropped, a params field
the release newly requires, or a missing method or definition refuses the launch as
`codex_incompatible_release` before app-server starts, and the refusal lists each change. A value
beyond those the admitted releases offer, such as a new item type, is recorded on the result and
reported as a warning; a new item type that arrives is still refused by the item allowlist.
The check covers only
the listed fields. It does not attest the binary, and the `config/read` keys the schema leaves
untyped are checked by exact value after launch.

## Authority and request limits

The host creates a private temporary Codex home and links only the existing
`auth.json`. humanish never reads or copies its values. The native CLI owns
authentication and provider network traffic. Its environment excludes provider
keys, target-app variables, alternate endpoints and operator configuration.
The selected native binary is launched directly; npm wrappers are resolved to
their native executable before launch.

Before creating a thread, humanish checks the effective config. Nonempty system
settings, inherited instructions, MCP, plugins, hooks, alternate stores/endpoints
and unsupported authority are rejected. The thread is ephemeral, has no runtime
environments or workspace roots, and uses only the supplied text/images and
closed output schema. No provider/model fallback is allowed.

This profile is **not advertised as tool-free**. The CLI retains code-mode
descriptions, but the qualified `features.code_mode_host=false` setting rejects
their actual dispatch. `agents.enabled=false` removes delegation; the older
feature toggle alone did not. humanish also refuses raw tool calls, unexpected
host RPCs and asynchronous question messages before accepting any report. Every
item an app-server notification carries (`item`, `items`, `turn.items`,
`thread.turns[].items`) passes the item allowlist whatever its method, from the
launch handshake until the app-server exits. Output that arrives after a request
stopped, or during shutdown, is still read for the item policy. Every refusal, and
any output that could not be checked, is kept for the session's close: it fails a
participant's run even when a step that tolerates a failed request absorbed it,
and it fails an analysis that had completed. A last frame cut off by humanish's
own signal, delivered to the running app-server and ending it, is a warning with
its byte count. A method humanish does not know that carries no item is counted
in the run's warnings and does not refuse. The actual notification/denial captures and provenance are in
[`tests/fixtures/restricted-codex`](https://github.com/danielgwilson/humanish/blob/46330116726f74080fa18947c36da4fb4b333805/tests/fixtures/restricted-codex/README.md).

Each analyst or readiness request owns a separate child process, temporary home
and fresh thread. Participants share the native session implementation with a
separate UI-tool policy: Code Mode can call one humanish desktop tool, and each
result supplies actual input acknowledgments and the current screenshot. Local
Firecracker and hosted E2B use this same participant implementation. Hosted
participants preserve operator authentication and model configuration; the
restricted analyst profile above remains unchanged.
Codex manages context compaction. humanish does not replace it with a rolling
history window or restart a failed conversation without its memory. Participant
threads never share conversation state with each other or the analyst.

An unresolved child process blocks new sessions until its exit is confirmed. Limits and
deadlines apply to each request, including startup on the first turn. Thread-cumulative token
usage is converted to per-turn usage before accounting. CLI 0.154.0 omitted compaction
requests from its thread totals, and later releases were not re-measured. A turn that compacts
therefore retains known counts but records incomplete usage. Evidence is not silently
downselected: at most 128 images, 20 MiB decoded image data, and 32 MiB serialized request
data are admitted. Generated report text is limited to 2 MiB. Raw input notifications echo
image data URLs, so their frame budget is the larger of 2 MiB (32 MiB for participant
requests) or the admitted serialized packet plus 1 MiB; total stdout is bounded separately at
the larger of 8 MiB or twice that frame budget plus 4 MiB. Stderr is bounded at 2 MiB and is
not retained. Notifications are limited to 65,536; aggregate generated assistant-text deltas
are independently limited to 2 MiB, regardless of the input-image wire budget. The request's
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
If native closure cannot be confirmed, humanish preserves its private state and
blocks another session in the same process until that exact child closes.

After confirmed closure, normal cleanup removes the owned auth symlink and
temporary directory. It never deletes or overwrites the operator's original
login. Unexpected replacement of the symlink is different: it might contain
rotated auth state. humanish preserves that private file with mode 0600 inside a
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

## Admitting a Codex CLI release

A release enters a host's list only with a dated receipt under
`docs/goals/computer-use-actor/receipts/` showing all of the following, on that host:

1. The release notes since the baseline were read for changes near the tool boundary.
2. A drift check against a release already qualified on the host found no exec, connection or
   file write the baseline did not make in the same scenarios, including live account-backed
   launches, and the same tool inventory, denials and isolate behavior. `pnpm codex:qualify`
   runs this check; see "The qualifier" below.
3. One hosted participant study with the candidate first on `PATH` (for example
   `PATH=<evidence>/npm-<version>/node_modules/.bin:$PATH pnpm humanish lab run <lab>
--env-file <file with E2B_API_KEY only>`) reached its goal in the final capture, with a
   verified request receipt, `humanish verify --run <id>` passing and the automatic Codex
   analysis recording the release. Keep `OPENAI_API_KEY` out of that environment so the
   participant stays on ChatGPT-account billing.

The drift check compares a candidate with a vendor release that has already been qualified. It
can show that an honest new release does nothing new in those scenarios; it cannot show that a
binary built to evade it is safe. Pair that with the attestation limit above: the launcher
admits by release string and does not pin the executable.

Then commit the release in `QUALIFIED_CODEX_CLI_VERSIONS`
(`src/actors/codex/qualified-versions.ts`) for that host, in `RECORDED_CODEX_CLI_VERSIONS`
(`src/actors/contract.ts`) and in the Observer's copy
(`observer/lib/actor-execution-profile.ts`). If any check fails, change no code and record
what differs.

### The qualifier

`pnpm codex:qualify` produces the drift evidence step 2 above requires. Its threat model:
it detects an honest new vendor release that, in these scenarios, executes a program, connects
to a destination or writes a file the baseline release did not, and it fails closed when the
harness cannot see (a failed trace, sampler read or parse). A binary built to evade it is out of
scope. Named limits, none of which it inspects:

- io_uring: a ring's operations bypass the traced syscalls. `io_uring_setup` is traced and any
  ring fails qualification, but what a ring would do is not seen.
- Writes on connected sockets: `write`, `writev` and `send` without an address on an already
  connected socket are not traced. The connect is, and the sampler lists held remotes.
- SCM_RIGHTS: descriptors passed over a unix socket are not followed.
- DNS payloads: a query to the resolver compares by destination, not by what it asks.
- `/proc/<pid>/` and the random suffixes of Codex's temporary names compare as patterns, so any
  pid and any suffix match.
- Paths inside a new mount namespace (bubblewrap's sandbox) compare as written, not as host
  paths. Work a process does in memory and writes through inherited descriptors are unseen.

It compares the candidate with a release already qualified on the host, so each step reports
differences, not absolute facts. Evidence lands under `.humanish/codex-qualify/` (gitignored).
It qualifies Linux hosts only: its process checks need `strace`, so on macOS, or on Linux
without `strace` on `PATH`, it refuses before installing anything. Apple Silicon therefore stays
at 0.154.0 until an equivalent macOS tracer exists.

1. `pnpm codex:qualify <version>` installs the candidate and a baseline from npm, then runs
   offline checks with no model or account. The baseline must be a release already qualified
   on this host and not the candidate; by default it is the newest qualified release older
   than the candidate, and `--baseline` must name a qualified release. Hosts with only the
   pre-existing admission have no baseline and cannot qualify a release this way. Every
   invocation of either binary runs under `strace -f -yy`, including `--version`, schema
   generation and feature listing. The trace follows the process and every descendant,
   detached ones included, and records execs, socket operations (`connect`, `bind`, `sendto`,
   `sendmsg`, `sendmmsg`, `socketpair`), write-intent file operations with their outcome, the
   working directory of each process (`chdir`, `fchdir`, `clone`) and `io_uring_setup`. A
   trace line outside strace's syscall grammar fails the trace. The only other lines allowed
   are strace's own: a process's exit or kill line, a signal delivery, a thread's execve
   superseding its thread-group leader, and the `???` start and `= ?` resumption strace prints
   for a call it could not decode in a thread being killed. Every traced process must reach
   its exit or kill line, so a trace cut short fails. A call still unfinished when its process
   ended counts as one it died in: an exec counts as run and a file operation as attempted. The
   checks:
   - the generated app-server schema: thread item, raw response item and server request types
     must be unchanged; new notifications and changed launcher-facing files are listed for
     review;
   - `codex features list` under the analyst and participant configs: every pinned feature
     keeps its stage and value; newly enabled features are listed for review;
   - the preparatory commands: each one's execs, sockets and file writes must stay within the
     baseline's same command. Schema-generator writes are skipped only when no path contains
     `..` and the kernel resolved the open inside the schema output directory, whose files the
     schema check above compares;
   - five loopback-provider probes on both releases (tool inventory, 18 injected tool calls,
     question tools, participant Code Mode lifecycle, and an isolate escape attempt). The
     candidate may advertise no more tools than the baseline. Inside the participant isolate,
     its own tool keys and its successful calls must stay within the baseline's, and a tool
     both releases expose must fail with the same message, so a refusal cannot turn into an
     input error unnoticed. Descriptions are not taken as dispatch evidence. It must return
     the same denials, the same question outputs and the same question-event multiset (order
     is listed for review), and the same participant lifecycle sequence.
   - execs, per scenario and overall. Each exec compares as its exact program path and argv,
     `argv[0]` included. The first exec must be the launched binary and is set aside. The
     candidate's execs in each scenario must all appear among the baseline's in the same
     scenario, so a helper cannot move from the participant to the analyst. None may carry an
     argument the model supplied, and nothing traced may outlive the app-server. A failure
     prints each added exec's raw and normalized argv. `execveat` resolves against the
     descriptor path `-yy` prints; an exec path relative to an unknown directory, a truncated
     argument, a missing `strace` or an unpaired start and result fails the check. Every
     release so far runs the same helpers: the Code Mode host for participants, a bubblewrap
     capability probe (`bwrap --unshare-user --unshare-net --ro-bind / / /bin/true`), and OS
     information (`lsb_release -a` with `getopt`, `cut` and `tr`, and `getconf LONG_BIT`).
   - sockets, per scenario. The traced connects, binds and sends must stay within the
     baseline's, and every TCP or UDP destination must be the loopback provider, however
     brief. A connect names the unix socket path even though the client socket itself is
     unnamed. Sends between the two ends of a socketpair the traced tree created stay inside it
     and are listed for review.
   - file writes, per scenario, from the trace, which also covers paths outside the work
     directory; and a recursive snapshot (path, type, size) of the probe's work directory
     (`HOME`, `CODEX_HOME`, the project and `TMPDIR`) before and after each scenario. Added,
     removed and retyped entries and traced writes must stay within the baseline's same
     scenario; size changes are listed for review. A relative path resolves against the
     process's tracked working directory, and one whose directory is unknown fails the trace.
     A successful open compares on the path the kernel reports through `-yy`. A `chdir`
     through `..` leaves the directory unknown until the kernel reports it (`AT_FDCWD<path>`),
     and a path containing `..` without a kernel-reported path fails the trace.
     Skipped events are judged one occurrence at a time, in order and on their outcome:
     - an open that the kernel resolved to the `-journal`, `-wal` or `-shm` file of a known
       database (`goals_1`, `logs_2`, `memories_1`, `queue_1`, `state_5`) it named, or an
       unlink of one, since those come and go with checkpoint timing. A symlink, link or
       rename that names one is always compared;
     - operations on a file whose first successful operation was an exclusive create
       (`O_CREAT|O_EXCL`, so it did not exist before) and whose last was a successful unlink,
       such as SQLite's `etilqs_` temporary files. A failed unlink is not a removal, and a
       recreation after the unlink keeps the file;
     - a successful unlink or rmdir, with no `..`, of a path inside the run's own private
       directory that an earlier create, rename or link in the same trace made and that was
       not there when the command started.
   - a `/proc` sampler, every 50 ms from spawn to close, over the app-server's descendant tree
     and any process carrying the probe's private `CODEX_HOME`. It records TCP and UDP
     remotes, bound unix paths and, through `ss`, the listener path behind each connected unix
     client. Nothing may outlive the app-server, TCP and UDP may reach only the loopback
     provider, and unix sockets must sit in the probe directory. Any read the sampler needs
     that fails for a reason other than the process having exited (including a zombie) fails
     qualification, for the baseline as for the candidate, and so does a `/proc` or `ss` table
     without its header, a row that does not parse, or an empty or malformed `stat`. A task
     that has begun to exit drops its memory map, and the kernel then gives its `/proc`
     entries to root, so when a process's descriptors refuse, each thread's are read; a thread
     that refuses counts as holding nothing only if its `stat` flags show it exiting
     (`PF_EXITING`) or it has exited. The one exception is a descendant that dropped
     dumpability, as bubblewrap's sandboxed child does: the kernel refuses its descriptors, so
     it is listed, and it must be one of the traced execs, whose sockets strace records.

   Events compare exactly after rewrites listed in the script and printed with every run, and
   nothing else. Literal paths: `<codex-home>` for a launch's private `CODEX_HOME`,
   `<operator-codex-home>` for the operator's own Codex home (the live operator-mode
   participant), `<probe>` and `<work>` for the offline probe's and a live launch's private
   directory, `<schema-out>` for the schema output and `<codex>` for the release's native
   vendor directory. File and socket paths, never exec argv, also get three patterns:
   `/proc/<pid>/`, and the six random characters of Codex's `codex-arg0` and `.tmp` temporary
   names. Addresses get labels: `<loopback>` for the offline provider, and live
   `<chatgpt.com>` for the addresses that host resolves to during the run and `<resolver>` for
   each `/etc/resolv.conf` nameserver. Snapshot entries whose names collapse to one pattern keep
   a numbered suffix, so an extra file still shows. Any `io_uring_setup` in any trace fails,
   since a ring's operations bypass the traced syscalls.

2. `pnpm codex:qualify <version> --live` adds account-backed phases through the real launcher,
   run for the baseline and then the candidate: readiness without a model turn, one analyst
   turn, an analyst cancelled at its first streamed delta and a participant cancelled during
   its first tool call. These use a small amount of account quota. Every launch of either
   binary, including its `--version` checks, runs under `strace`, and each app-server is also
   sampled. Each candidate launch's execs, sockets, file writes and sampled TCP and UDP remotes
   must stay within the baseline's same launch, TCP and UDP may reach only `<chatgpt.com>` and
   `<resolver>`, and no traced connect or sampled socket may reach the operator's Codex daemon
   socket. A sampler failure on either release fails. The
   baseline's phases must reach the same outcomes, so its launches are comparable. The
   script admits the candidate through `cliVersions`, an internal launcher option that
   bypasses the host list; no library export, manifest, CLI flag or run hook reaches it.

Removing a release from a host list stops new launches only; readers keep accepting it.
