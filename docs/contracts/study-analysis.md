# Study analysis

Study analysis is an independent interpretation of retained participant evidence.
It is separate from the participant's account, recorded outcome, and the run's
deterministic review verdict. Opening an Observer never starts a provider request.
Supported live runs request analysis on completion by default, with a separate
$3 admission estimate limit. Set `review.analysis: false` to disable that request;
see [automatic analysis](../product/automatic-analysis.md).

## Invocation

```bash
humanish analyze --run latest --max-cost 3 --dry-run --json
humanish analyze --run latest --max-cost 3 --json
humanish observe --run latest
humanish analyze list --run latest --json
humanish analyze show --run latest --json
```

The source must be a verified, completed live run. A dry-run contract bundle is
not a participant study. Here, `analyze --dry-run` means checking an existing
study's input and admission estimate without credentials, a provider request,
or a new analysis artifact.

The default model is `gpt-6-astra`, with high reasoning effort. A request sends selected retained text and
captures to OpenAI, without tools, redirects, provider-side response storage, or
automatic retries. `--question` adds a reviewer question; it never changes the
participant assignment. `--max-cost` is required, including for dry-run
admission. It bounds a conservative estimate, not an exact provider bill.
`--timeout-ms` and `--max-output-tokens` bound the request. An exceeded admission
estimate retains valid findings and usage but returns a partial result and a
nonzero command exit, including when that version is reused.

The defaults allow ten minutes and 32,768 output tokens, including reasoning.
The configured wall-clock deadline covers the entire request, including waiting
for response headers and reading the body. A request-scoped dispatcher prevents
Node's separate fetch timeout from cutting a longer configured deadline short;
it does not change other network requests in the process. Transport failures
retain only an allowlisted cause code, never provider exception text or URLs.
The analysis checks the assigned requirements against the retained end state;
an unverified essential result remains unknown even if the participant reported
success. Findings keep reported concerns and observed recovery distinct across
participants. Other supported models can be selected explicitly, but evidence
reference validation does not certify their interpretation of small visual details.

Analysis distinguishes participant actions from harness setup and accounting.
Runtime credentials or model usage do not establish that a participant made an
external call while performing their task. Observations with an action basis
must cite an action-bearing source; invalid source bases are rejected with the
attempt's status and known usage retained.

Identical source input, configuration, and prompt version reuse a current valid
analysis. `--rerun` creates another immutable version. Failed attempts do not
hide earlier valid findings. Ctrl-C cancels the request; usage remains unknown
when the provider did not report it. Cancellation cannot undo an already accepted
provider request.

Decoded participant context, evidence text, and the reviewer question are checked
for known sensitive-text patterns before dispatch. JSON escaping cannot bypass
that check. Image bytes are not treated as text for pattern matching.

Only one analysis command can own a run's `.analysis-lock` directory. Interrupted
locks are not stolen using stored PIDs. After confirming the owning command has
stopped, an operator can remove the empty lock directory and retry.

## Evidence and findings

The packet currently admits up to 16 participants, 800 evidence items, 40 PNG
captures, 160 KiB of text and 20 MiB of images. Individual source files, image
dimensions and result sizes have separate limits. Count and text budgets are
distributed across included participants, with unused capacity from short
sessions available to longer ones. Capture selection prioritizes session endings
and beginnings, context around recorded failures, and spread across each whole
session. Failure priority uses structured source status, not application-specific
keywords or image interpretation. Unflagged visual errors may still be omitted.
Bounded reads and the total image byte limit can reduce coverage further.
Selected entries retain their original source order, frame and event identities;
this is not a statistically representative sample. Selection
omissions and unreadable or invalid capture files make declared coverage
incomplete. Coverage records file availability and selection; it does not
certify visual legibility, correct interpretation, or exhaustive issue discovery.

New packets declare `captureVersion: 2`, bound into their input digest. They
include captures attached to `screenshot` and scripted `ui_action` events,
preserving the original action IDs and evidence basis. Error notices that refer
to an earlier capture retain that context without creating another frame.
Scripted lanes use their recorded `ui.intent` goal when no participant assignment
exists. Missing assignments and declared captures without supported trace
references are explicit omissions. Artifacts without `captureVersion` continue
to validate against the original capture mapping; previously saved selections
are not recomputed or rewritten.

The standard review covers session summary, apparent intent, observed outcome,
friction, dead ends, recovery, and participant feedback. Findings are ordered by
observed task impact, replication among exposed participants, and recovery.
Impact and confidence remain separate. There is no numeric frustration or
universal priority score.

The standard review also accounts for material participant concerns before
ranking findings. Reported uncertainty can be useful even when the interface is
correct or study setup may explain it. Claims distinguish that experience from
an established product defect, preserve consequential recoveries, and check
participant accounts against the actual assignment and captured state.

New results include `concernReviews`: evidence-linked observations with a
`finding`, `context`, or `unsupported` disposition and a concise reason. A finding
disposition references an existing local finding ID; other dispositions use null.
The Observer's **Concerns considered** disclosure exposes these decisions and
their original evidence. There is no required finding count or inventory of every
thought. Older reports may omit this field and remain readable. The disclosure
is model-generated assessment, not an independent completeness audit or a human
reviewer annotation.

Every observation cites packet-local evidence IDs. The model cannot choose a
filesystem path or fetch another resource. Validation checks participant
membership, unique counts, quote fidelity, evidence type and reference
integrity. Visual claims require retained captures; screenshot-free evidence
opens its original event. These checks do not prove that every interpretation
is correct or every consequential issue was found.

Elapsed replay time starts at the first retained capture. It is not a video
offset. Nonvisual events retain event identity without invented frame offsets.
Scripted captures without recorded timestamps keep null analysis times; any
uniform playback pacing is an estimate, not an observed duration.

Finding previews select from the finding's cited entries. They prefer a capture
directly cited as visual evidence, then the number of distinct visual/action
observations citing it; equal support keeps citation order. Duplicate claims do
not increase support. This is a display heuristic, not a confidence score or a
guarantee that the selected capture is the most relevant. Context-only and
nonvisual evidence retain their basis and original event. All cited moments stay
available, with exact recording links.

Confidence, recovery and the first full evidence limitation remain visible when
a finding opens. Exposure and remaining unique limits are one disclosure away;
observation details retain each original claim and its specific limitation.
This presentation does not rewrite the saved analysis or reviewer corrections.

## Durable records

The frozen `humanish.observer-data.v1` schema is unchanged. A companion
`humanish.study-analysis.v1` artifact records source/config/input hashes,
participant context, evidence manifest, coverage, provider/model/prompt version,
status, usage and validated findings:

```text
.humanish/runs/<run>/
  analysis/<analysis>/analysis.json
  analysis/<analysis>/corrections/<correction>/correction.json
  analysis-attempts/<analysis>/start.json  # before transport; outcome initially unknown
  analysis-attempts/<analysis>/receipt.json
  observer/study-analysis.json
  analysis-automatic/job.json  # post-run lifecycle; never a retry instruction
```

The optional automatic job is separate from the immutable analysis. Its view
binds terminal state to the exact execution receipt and report. A stale or
unverifiable job remains unknown; reading or exporting it never dispatches.
Automatic job metadata is omitted from shared derivatives. See
[automatic analysis](../product/automatic-analysis.md).

Version and correction directories are claimed exclusively; publication is
atomic. Source evidence is not rewritten. Minimal execution receipts retain
model, budget, status and known usage even if source changes prevent report
publication. They contain no question, participant text, images, or findings.
`analyze list --json` includes these receipts.

New requests first claim their execution directory and atomically publish
`start.json` (`humanish.analysis-execution-start.v1`) before provider transport.
It contains only the attempt/run IDs, input/config/source digests, prompt version
and timestamp. The live caller retains a binding to that exact directory and
publishes the final receipt once. A start without usable final accounting means
dispatch and spend remain unresolved; it is not proof that a provider charged.
A cancellation before transport can finalize with `usage.dispatched: false`.
Admission refusals, missing credentials and rejected dispatch guards do not
create a potentially paid attempt. Reuse does not create a new start.

`humanish stats` reads all retained execution IDs, including failed, cancelled,
unpriced and unresolved attempts. Report/receipt copies and automatic reuse
count once per run and analysis ID. Legacy report usage can contribute without
a fresh source or valid findings, but the missing execution receipt is labeled.
This accounting read never approves findings or requests a provider. See
[study cost statistics](study-costs.md) for the additive JSON contract and
run-date attribution.

Analysis and execution-history directories each admit 256 entries, including
interrupted writes; correction history admits 256 entries per analysis. A new
attempt requires readable inventories with room for its records before dispatch.
Valid reuse remains available at capacity. The command does not remove old
versions automatically. A present correction that cannot be read or validated
blocks sharing and feedback promotion until the history can be checked.

States distinguish no analysis, complete with no findings, complete with
findings, partial, failed, cancelled, stale and invalid. A copied or modified
source cannot silently inherit a current analysis. Saved HTML and the HTTP
companion project validated records; generic HTTP serving of producer-owned raw
analysis/correction JSON, execution receipts, atomic write temporaries and locks
is disabled. Existing adapter captures and logs retain their contained routes.

## Human review and sharing

```bash
humanish analyze correct --run latest --analysis <id> --finding F1 \
  --status confirmed --reason "The cited captures reproduce the blocker."
humanish analyze correct --run latest --analysis <id> --finding F1 \
  --status amended --reason "The claim was too broad." --claim "A narrower supported claim."
humanish feedback issue --run latest --analysis <id> --finding F1 --repo owner/repo
```

Corrections append against exact analysis and finding hashes. Confirming one
version does not approve a later claim. Dismissed findings cannot become feedback
drafts; amendments preserve the original and record the replacement. Feedback
drafts include source/version/evidence references and remain explicitly
independent of participant-authored candidates. No command above posts to GitHub.
Each analysis has room for 256 correction inventory entries, including interrupted
writes. A full or unsafe inventory refuses a new correction before creating its
entry; prior records remain unchanged. Analysis and correction commands share the
run lock so concurrent writers cannot overrun that bound.

The existing sharing gate scans source and derived text. Export and feedback
also check the exact in-memory analysis snapshot they include. Sensitive derived
text blocks sharing and is quarantined from Observer, while independently
verified source recordings remain viewable. Filesystem containment failures
still fail closed. Valid failed/cancelled history alone does not downgrade
sharing.

Redacted bundle export omits analysis, corrections and execution receipts and
records that omission in derivation provenance. Changed source bytes require
new analysis; old hashes and review approvals cannot survive redaction. Ordinary
legacy evidence under `analysis/` remains part of the recording and follows the
normal redaction and sharing checks.
