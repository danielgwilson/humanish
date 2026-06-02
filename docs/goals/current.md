# Current Goals

Status date: 2026-06-02

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
  artifacts, and verifier output;
- clear pass, fail, blocked, and gap states;
- public-safe feedback issue drafts that do not mutate GitHub by default;
- adapter contracts that let projects customize behavior without forking core;
- release gates that prevent PII, PHI, secrets, private artifacts, and stale
  internal residue from reaching the public repo or package.

## Current Objective

Make the public package and repo credible enough that an external maintainer can:

1. install the skill;
2. install `mimetic-cli`;
3. run `mimetic init`;
4. run `mimetic watch`;
5. inspect Observer evidence;
6. verify the bundle;
7. produce a public-safe feedback draft;
8. understand the next live-adapter path without reading chat history.

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
- `verify` fails closed if required evidence is missing.

### 5. Live Terminal And Codex Lanes

Make local PTY and Codex-style lanes reliable enough that Observer can show
running, passed, failed, blocked, and timed-out states without human inference.

Minimum acceptance:

- sanitized transcript persistence;
- explicit completion reason;
- verifier checks redaction status;
- Observer polling reflects lane completion;
- no raw private transcript or credential values.

### 6. OSS Lab Health Readback

Make `mimetic lab oss` report nested lane health back into the top-level
Observer instead of relying on a human watching the desktops.

Minimum acceptance:

- each lane records setup status;
- each lane records nested Observer URL or absence;
- each lane records nested verification status or blocker;
- top-level Observer updates lane verdicts from evidence.

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
- live labs require private infrastructure to look impressive;
- package docs link to files that are not shipped;
- public-safety gates become optional.

## Best Next Work

The next most useful engineering slice is fresh-agent install proof against a
disposable public app fixture, followed by the first real browser adapter.

That sequence keeps the package honest: first prove a new maintainer can start,
then prove Mimetic can observe real product behavior.
