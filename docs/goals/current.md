# Current Goals

Status date: 2026-06-10 (rev 2)

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
  labs against real apps (0.5.0; see `docs/goals/proof-roadmap/goal.md` and
  `docs/principles/invariants-and-defaults.md` in the repository — repo-only
  docs, not shipped in the npm package). `done`
- De-paranoia (0.6.0): the redaction redesign + demoted defaults. Screenshots are
  full-fidelity by default (redaction binds the publish boundary, not capture —
  `policies.redactScreenshots` opts back in); `policies.allowPublicTargets` lets an
  owner drive a declared deployment/preview; `subject.clone.keep` is honored on
  failure for debugging; `serve.installTimeoutMs`/`buildTimeoutMs` are configurable
  for monorepo-scale builds. Doctrine updated with the capture-vs-publish rule. This
  re-sequences the proof roadmap: a redaction redesign and an overridable
  public-target policy are prerequisites for any decision-grade depth evidence, so
  they land BEFORE the nobg/image-skill depth phases. `done`

### 5. Live Terminal And Codex Lanes

Make local PTY and Codex-style lanes reliable enough that Observer can show
running, passed, failed, blocked, and timed-out states without human inference.

Minimum acceptance:

- sanitized transcript persistence;
- explicit completion reason;
- verifier checks redaction status;
- Observer polling reflects lane completion;
- no raw private transcript or credential values.

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
