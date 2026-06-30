# Current Goals

Status date: 2026-06-30 (rev 12)

This page is the current public-safe operating goal for `mimetic-cli`. Keep it
short enough to reread before a coding session and concrete enough that future
agents can choose useful work without private context.

## North Star

Mimetic should be the open-source CLI that lets a maintainer ask:

> What happens when realistic synthetic personas try to use this app, CLI, or
> agent-facing workflow?

The answer should be observable, verifiable, public-safe, and easy to turn into
actionable feedback.

## Definition Of Awesome

A world-class Mimetic run should eventually provide:

- one human-friendly command that starts simulations and opens Observer;
- multiple synthetic personas with different goals, patience, and skill levels;
- UI, CLI, TUI, and code-agent lanes in one mission-control Observer;
- real evidence: screenshots, terminal transcripts, lifecycle events, traces,
  filesystem setup-quality snapshots, artifacts, and verifier output;
- clear pass, fail, blocked, and gap states;
- public-safe feedback issue drafts that do not mutate GitHub by default;
- first-class `.yaml` lab manifests for reusable simulation runs;
- adapter contracts that let projects customize behavior without forking core;
- release gates that prevent PII, PHI, secrets, private artifacts, and stale
  internal residue from reaching the public repo or package.

## Current Objective

Make the public package and repo credible enough that an external maintainer can:

1. install the skill;
2. install `mimetic-cli`;
3. run `mimetic init`;
4. run `mimetic watch`;
5. run `mimetic watch first-run` or another lab manifest;
6. inspect Observer evidence;
7. verify the bundle;
8. produce a public-safe feedback draft;
9. understand the next live-adapter path without reading chat history.

## Near-Term Goals

### 1. Public Readiness

Keep the repository clean and public-safe.

Acceptance:

```bash
pnpm release:check
git diff --check
```

Fresh clone release checks should pass before public visibility changes.

### 2. Future-Agent Ramp

Maintain a durable ramp that tells future contributors and coding agents where
to start, what exists, what remains, and what proof is required.

Acceptance:

- [`docs/ramp/README.md`](../ramp/README.md) stays current;
- this page stays current;
- README links both;
- release package includes both docs directories.

### 3. Fresh-Agent Install Proof

Prove the skill and package setup flow from a disposable target app with no chat
context.

Target proof:

```bash
npm i -D mimetic-cli
npx mimetic init --yes
npx mimetic watch --json --no-open
npx mimetic verify --run latest --json
npx mimetic feedback issue --run latest --repo owner/repo --format markdown
```

The proof target must use synthetic personas and no real user data.

### 4. Live Browser Adapter

Graduate from synthetic UI lanes to a real browser journey against a local app.

Minimum acceptance:

- local app target detection;
- browser launch;
- route/state capture;
- screenshot artifact;
- run bundle references screenshot evidence;
- Observer renders the screenshot;
- `verify` fails closed if required evidence is missing;
- bounded desktop/mobile two-step browser persona proof with per-step traces and
  screenshots. `done`
- LLM-driven browser lane: the registered `openai-computer-use` actor dispatches
  from a lab config (`subject.source: app-url`, loopback entry only) into a hosted
  E2B desktop, fills the provider-neutral `stream.actor` trace seam, and persists
  a verified redacted bundle (0.3.0 registered the actor; 0.4.0 made
  `actors[].type` a real dispatch key). `done`
- Clone subject provider: `subject.source: clone` + `serve` clones a repo INTO the
  sandbox, installs/builds/starts it from config, probes readiness, and records
  provenance (repo, commit, env names) in the bundle — config-only computer-use
  labs against real apps (0.5.0; see `docs/goals/proof-roadmap/goal.md` —
  repo-only, not shipped in the npm package — and
  `docs/principles/invariants-and-defaults.md`, which ships in the package).
  `done`
- De-paranoia (0.6.0): the redaction redesign + demoted defaults. Screenshots are
  full-fidelity by default (redaction binds the publish boundary, not capture —
  `policies.redactScreenshots` opts back in); `policies.allowPublicTargets` lets an
  owner drive a declared deployment/preview; `subject.clone.keep` is honored on
  failure for debugging; `serve.installTimeoutMs`/`buildTimeoutMs` are configurable
  for monorepo-scale builds. Doctrine updated with the capture-vs-publish rule. This
  re-sequences the proof roadmap: a redaction redesign and an overridable
  public-target policy are prerequisites for any decision-grade depth evidence, so
  they land BEFORE the consumer-web-app / agent-skill depth phases. `done`
- Device presets (0.6.1): viewport/device is a real dimension, with LITERAL values copied
  from the in-house sims (mobile 414×896 … wide 1920×1080; default `desktop` 1440×950) —
  not guessed. `execution.desktop.device` picks the per-run viewport; the guessed 1280×800
  is gone. Honest fidelity: on the E2B route only width/height render (real mobile *layout*)
  + the model is told its device, matching the sims' organic lanes; true touch/DPR/UA needs
  the CDP actor. Per-*persona* device (N×devices) rides fan-out. `done`

### 5. Live Terminal And Codex Lanes

Make local PTY and Codex-style lanes reliable enough that Observer can show
running, passed, failed, blocked, and timed-out states without human inference.

Minimum acceptance:

- sanitized transcript persistence;
- explicit completion reason;
- verifier checks redaction status;
- Observer polling reflects lane completion;
- no raw private transcript or credential values.

Terminal-product real-agent lane (0.8.0; depth-axis layer 6, so an adopter can delete a
bespoke real-agent sim for mimetic + a thin adapter — see
`docs/goals/terminal-product-lane/goal.md`):

- `subject.source: terminal-product` + `execution.target: e2b-terminal` + the registered
  `codex-exec` terminal actor route a config to a real Codex agent studying a product from
  public surfaces inside an E2B shell. `done`
- The credential-placement inversion is enforced by construction AND by verifier: the runtime
  key is injected ONLY command-scoped into the `codex` invocation, never sandbox-global; a
  deny-by-default allowlist excludes GitHub/payment/deploy/db creds; metadata is a positive
  allowlist; stdin is disabled with an always-present interventions ledger; cleanup is proven
  or the run fails closed. `done`
- Cost/no-spend ledger with the null-vs-known-zero-vs-absent discipline (unknowns are `null`,
  never guessed); the no-spend proof is DERIVED from the ledger, never asserted; `maxUsd`/
  `maxJobs`/`maxMinutes` caps enforced fail-closed. `done`
- Product-adapter extension seam: exported contract types + a scorer/feedback DI hook +
  adapter-namespaced product nouns, so an adopter attaches scoring/feedback as a thin
  in-repo extension without forking core. `done`
- Honest gap: the lane's mechanics + credential boundary are proven DETERMINISTICALLY; a live
  "real Codex agent completed a task" receipt is pending a dedicated test E2B key (isolated
  from prod) and a sandbox image with the agent runtime installed
  ([#159](https://github.com/danielgwilson/mimetic-cli/issues/159)). Duplex-PTY/xterm replay
  is a deferred SLICE 5.

Multi-lane fan-out for the computer-use lab (0.9.0; proof-roadmap layer 2, the prerequisite
for multi-actor shared-state work — #163, see `docs/goals/multi-lane-fanout/goal.md`):

- `actors[0].lanes[]` (differentiated roster: per-lane persona/device/starting-surface) XOR
  `actors[0].count` (homogeneous) fan out N independent E2B desktops in ONE run bundle;
  `per-lane worlds` is the only topology this slice (shared-world is #164). `done`
- `execution.concurrency` bounds in-flight paid desktops (default min(N,3); env may only
  lower it); a pre-flight spend/lane plan prints before any sandbox/provider call and at $0
  in dry-run; per-lane teardown reclaims ONLY each lane's own sandbox by id (never
  account-wide). `done`
- Proven deterministically (fake substrate: bounded concurrency, by-id teardown, fail-fast,
  hollow-lane caught) AND with a kept live rung (2 lanes, two distinct desktops, both
  reclaimed by id, bundle verifies — `docs/goals/multi-lane-fanout/receipts/`). `done`
- Deferred: seed-fork provisioning (PR-2), in-process-route fan-out, shared-world topology
  (#164).

Shared-world topology — multi-actor against ONE shared mutable service (0.10.0; proof-roadmap
layer 7; #164; `docs/goals/shared-world-topology/`). The north-star sim leverage: MANY personas,
ONE shared world.

- Sequential (`topology: shared-world`, concurrency 1): one sandbox, N role seats take turns
  against the shared DB; a checkpoint timeline proves role B acted on a world already containing
  role A's mutation. `done`
- **Concurrent (`topology: shared-world` + `concurrency > 1`): one subject sandbox served +
  `getHost`-exposed, N actor desktop sandboxes drive that one URL SIMULTANEOUSLY** (reuses fan-out
  orchestration; all N+1 reclaimed by id). Honest attribution under concurrency: per-persona
  outcomes + harness-clocked `laneWindows` proving real overlap + a `stateSeries` of the shared
  world under load; causation is structurally inexpressible (independent series, no
  per-delta→actor field). `done`
- A new `attributionClass: isolated | shared-world` honesty axis + verify FAIL-CLOSED on the
  required/forbidden `attributionLimits` sets + a concurrency-on-pass gate (a passed concurrent
  run must show real overlap AND a state delta coincident with it). `getHost` URLs are
  internet-reachable → the route is gated (verify) to synthetic+seeded subjects; the raw URL is
  digest-only in evidence. `done`
- **LIVE-PROVEN (0.10.1):** a kept live receipt ran 3 personas concurrently against ONE
  getHost-exposed synthetic plane — all 3 passed, all 3 lane-windows overlapped on the real clock,
  the shared stateSeries evolved under load, N+1=4 sandboxes reclaimed by id, verify ok
  (`docs/goals/shared-world-topology/receipts/concurrent-live-rung-2026-06-17.md`). One trial =
  phase-change proof, not scale. The next step is the real downstream sim migration (a
  synthetic-seeded multi-role app in the adopter's domain). Per-action causation,
  cross-sandbox concurrency beyond getHost, and #108 PII/PHI remain out of scope.

Adopter-driven engine features (0.11.0; surfaced by real bespoke-sim migrations):

- `execution.desktop.template` — run a lab on a CUSTOM E2B desktop image (name/ID) instead of the
  stock `desktop` template, threaded to `Sandbox.create(template, opts)` via one
  `createDesktopSandbox` seam across every desktop route (cua single+fan-out, sequential +
  concurrent shared-world subject+actors). Absent == the byte-stable stock-template call; recorded
  as `RunBundle.desktopTemplate`. Lets a Node/bun/DB-bearing adopter image run without
  installing the runtime per lane. `done`
- `mimetic observe --run <id>` — serves a run's Observer over `http://127.0.0.1:<port>` (loopback
  only, path-traversal-guarded to the run dir, `/`->`/observer/index.html`) instead of `file://`,
  so browsers/automation can open it and artifact links resolve. `done`

Patch hardening (0.11.1):

- concurrent shared-world review now fails closed when any actor lane records a failed terminal
  trace; a lane can remain evidence without making the aggregate review green. `done`
- scripted-browser labs can provision a single cloned synthetic subject, expose it through a
  tokenless sandbox host, and drive deterministic scripted steps while persisting only public-safe
  provenance and host digests. `done`

Adopter-driven roster/readback ergonomics (0.12.0):

- Lane grouping metadata (`actorType`, `surface`, `caseGroup`) is adapter-owned and projected into
  Observer `laneGroups[]` plus stream labels, so downstream projects can group simulated users
  without teaching Mimetic private role names. `done`
- `actors[0].roster[]` is compact authoring sugar for repeated lane groups. The parser expands it
  into deterministic `lanes[]` (`<group.id>-01`, `<group.id>-02`, ...) before the engine runs, so
  the runtime and run bundle keep one normalized lane shape. `done`

Provenance hardening (0.12.1):

- Clone-subject provenance now refreshes after successful provisioning phases, so `subject.commit`
  records the served subject HEAD rather than only the initial clone HEAD. This preserves truthful
  run-bundle provenance when an adopter's install/provisioning step checks out the exact revision to
  test. `done`

Adapter artifact evidence (0.12.15 candidate):

- Browser/shared-world adapter hooks may now write product/state proof files under the ignored run
  directory and return namespaced `mimetic.adapter-artifact.v1` references. Core validates only the
  generic reference shape and local-path safety, Observer links the artifacts, and `verify` fails
  closed if a referenced file disappears. The payload schema and product nouns stay in the adapter's
  namespace. `done`

### 6. Lab Manifest Shape

Make reusable simulations feel like source artifacts, not hardcoded command
branches.

Minimum acceptance:

- `mimetic/labs/*.yaml` is the committed lab source convention;
- `.mimetic/labs/*.yaml` and `.mimetic/local/labs/*.yaml` are ignored local
  overlays;
- `mimetic watch [lab]`, `mimetic lab list`, `mimetic lab inspect <lab>`, and
  `mimetic lab run <lab>` are supported;
- `--env-file <path>` loads local values for the current command without
  persisting values into artifacts;
- maintainer dogfood labs such as `oss` are examples, not the canonical
  consumer taxonomy.

### 7. OSS Lab Health Readback

Make the maintainer `oss` lab report nested lane health back into the
top-level Observer instead of relying on a human watching the desktops.

Minimum acceptance:

- each lane records setup status; `done`
- each lane records target app status/URL or blocker; `done`
- each lane records nested Observer presence; `done`
- each lane records nested verification status or blocker; `done`
- each lane records setup-quality filesystem evidence and Observer can inspect
  it; `done`
- top-level Observer updates lane verdicts from evidence; `done`
- feedback candidates are derived from setup-quality/actor evidence; `done`
- Codex app-server actor telemetry is persisted as redacted trace, event, and
  transcript artifacts; `done`
- each lane receives a meaningful-use score over setup, filesystem, nested
  Mimetic proof, actor activity, product surface, and feedback; `done`
- provider-backed nested app-url proof now drives a bounded two-step
  desktop/mobile browser persona journey in a headed E2B lane; `done`
- app-specific executable browser steps can now be authored under
  `mimetic/scenarios/*.yaml` and are summarized into top-level nested proof
  evidence; `done`
- repeated public app/tool headed proofs with app-specific manifests have passed
  against two public targets; `done`
- next gap: richer multi-step product journeys and broader multi-persona
  matrices.

## Non-Goals

Do not make these default behavior:

- live provider spend;
- GitHub API mutation;
- hosted queues, databases, or webhooks;
- production deploys;
- real customer/user/patient data;
- private screenshots or raw transcripts;
- private upstream artifacts.

Maintainer-only tooling can exist later, but it must be opt-in, token-explicit,
and dry-run-first.

## Drift Alarms

Stop and correct course if:

- docs start depending on chat memory;
- Observer gets prettier without stronger evidence;
- feedback drafts imply product proof from synthetic contract proof;
- tests pass while generated artifacts are not inspectable;
- actor setup/use trials produce findings that never become feedback candidates;
- live labs require private infrastructure to look impressive;
- package docs link to files that are not shipped;
- public-safety gates become optional.

## Best Next Work

The next most useful engineering slice is repeated agent dogfood against real
apps and tools, while preserving the public-safety boundary:

- public/open-source fixture proof for publishable examples;
- private maintainer dogfood through the repo-only public-safe packet, which is
  intentionally not part of the npm payload, at
  [`docs/goals/private-repo-agent-dogfood/goal.md`](https://github.com/danielgwilson/mimetic-cli/blob/main/docs/goals/private-repo-agent-dogfood/goal.md);
- then richer provider-backed app-specific browser persona manifests.

That sequence keeps the package honest: first prove a new maintainer or agent
can start, then prove Mimetic can observe real product behavior, then use the
failures to improve the harness.
