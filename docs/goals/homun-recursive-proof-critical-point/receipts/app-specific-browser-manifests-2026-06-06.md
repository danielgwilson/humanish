# App-Specific Browser Manifests Receipt: 2026-06-06

## Scope

This receipt covers the slice where Homun scenario source can define
executable browser persona steps and the OSS meta-lab can summarize nested
browser traces back into the top-level Observer.

Public targets used for provider-backed proof:

- `maciekt07/TodoApp`
- `lissy93/dashy`

No private repos, private source snippets, provider sandbox ids, stream auth
URLs, token values, PII, PHI, or secret values are recorded here. Runtime
artifacts remain under ignored `.homun/` paths.

## Implementation Delta

- `homun/scenarios/*.yaml` can now provide executable browser steps through
  a scenario-level `browser.steps` block or compatible step-level
  `steps[].browser` shape.
- `homun run --app-url` selects the first executable browser scenario from
  source before falling back to the built-in browser persona.
- Supported browser actions include `goto`, `fill`, `click`, `assertText`,
  `waitForText`, and `waitForSelector`.
- Supported expectations include text presence, selector visibility, URL
  inclusion, and visible-state change.
- Malformed executable browser scenario source fails closed.
- Nested browser trace summaries are projected into OSS meta-lab evidence and
  Observer timeline events as `oss-meta.nested.step_trace.summary`.
- The OSS meta-lab bootstrap writes an app-surface browser scenario after the
  target app is HTTP-ready, then runs nested Homun live app-url proof.
- Provider bootstrap install behavior now avoids `pnpm --workspace-root` when
  the checked-out target is not a pnpm workspace.

## Local Browser Proof

Run id:

```text
app-manifest-local-proof
```

Command shape:

```bash
HOMUN_BROWSER_COMMAND="<local browser executable>" \
pnpm homun -- run \
  --cwd <disposable fixture app> \
  --app-url http://127.0.0.1:<fixture-port> \
  --sims 2 \
  --run-id app-manifest-local-proof \
  --json

pnpm homun -- verify \
  --cwd <disposable fixture app> \
  --run app-manifest-local-proof \
  --json
```

Readback:

- scenario id: `fixture-onboarding`;
- scenario source: `homun/scenarios/fixture-onboarding.yaml`;
- desktop and mobile traces passed;
- executable steps included `goto`, `fill`, and `click`;
- assertions included text presence and visible-state change;
- verification passed.

## Provider Proof: TodoApp

Run id:

```text
oss-meta-2026-06-06T04-32-27-418Z-f8642378
```

Command shape:

```bash
pnpm homun -- watch oss \
  --env-file <local provider env file> \
  --repo maciekt07/TodoApp \
  --repo CorentinTh/it-tools \
  --count 2 \
  --no-redact-repos
```

Readback for `maciekt07/TodoApp`:

- lane `oss-01-desktop` passed;
- target app was running;
- nested Observer was present;
- nested verification passed;
- visual desktop layout was visible;
- nested browser trace summary passed;
- scenario id: `todo-app`;
- scenario source: `homun/scenarios/app-surface-browser.yaml`;
- counts: `4/4` steps passed across `2` browser surfaces;
- top-level Observer emitted `oss-meta.nested.step_trace.summary`;
- `pnpm homun -- verify --run oss-meta-2026-06-06T04-32-27-418Z-f8642378 --json`
  passed schema, redaction, review artifact, public-safety, local evidence, and
  Codex app-server evidence checks.

The same aggregate run also included `CorentinTh/it-tools`, which failed
honestly:

- target app started;
- nested browser proof captured `0/4` passed steps;
- top-level Observer emitted a warning-level
  `oss-meta.nested.step_trace.summary`;
- aggregate review verdict was `fail`.

That failure is useful evidence, not a hidden exception.

Provider cleanup after the two-lane run:

```text
killed: 2
matched: 2
remaining: 0
errors: 0
```

## Provider Proof: Dashy

Run id:

```text
oss-meta-2026-06-06T04-36-08-860Z-11dd0611
```

Command shape:

```bash
pnpm homun -- watch oss \
  --env-file <local provider env file> \
  --repo lissy93/dashy \
  --count 1 \
  --no-redact-repos
```

Readback:

- aggregate review verdict: `pass`;
- lane `oss-01-desktop` passed;
- target app was running;
- nested Observer was present;
- nested verification passed;
- visual desktop layout was visible;
- nested browser trace summary passed;
- scenario id: `dashy`;
- scenario source: `homun/scenarios/app-surface-browser.yaml`;
- counts: `4/4` steps passed across `2` browser surfaces;
- top-level Observer emitted `oss-meta.nested.step_trace.summary`;
- `pnpm homun -- verify --run oss-meta-2026-06-06T04-36-08-860Z-11dd0611 --json`
  passed schema, redaction, review artifact, public-safety, local evidence, and
  Codex app-server evidence checks.

Provider cleanup after the Dashy run:

```text
killed: 1
matched: 1
remaining: 0
errors: 0
```

Local watcher cleanup readback also found no remaining observer listener or
Homun watcher process after the run.

## Feedback Candidate Proof

The provider bundles produced public-safe feedback candidates from setup quality
and meaningful-use evidence. For the passing Dashy run, the strongest candidate
was:

```text
id: study-quality-oss-01-desktop
summary: Generated Homun setup for lissy93/dashy was ceremonial
actual: Study-quality rating ceremonial from 2/5 app-specific leverage signals.
```

Command:

```bash
pnpm homun -- feedback issue \
  --run oss-meta-2026-06-06T04-36-08-860Z-11dd0611 \
  --repo lissy93/dashy \
  --format markdown \
  --json
```

Readback:

- schema: `homun.feedback-result.v1`;
- `ok: true`;
- source candidate id: `study-quality-oss-01-desktop`;
- GitHub mutation: not performed;
- evidence paths point only to local ignored `.homun/` artifacts.

## Verification Commands

```bash
pnpm vitest run tests/run.test.ts tests/oss-lab.test.ts
pnpm typecheck
pnpm homun -- verify --run oss-meta-2026-06-06T04-32-27-418Z-f8642378 --json
pnpm homun -- verify --run oss-meta-2026-06-06T04-36-08-860Z-11dd0611 --json
pnpm homun -- lab cleanup oss --json
```

Results before release-gate rerun:

- focused tests passed: `2` files, `64` tests;
- typecheck passed;
- both provider bundles passed verification checks;
- cleanup readback showed `0` remaining matching provider desktops.

## Honest Remaining Gaps

- The generated provider scenario is app-specific to the detected app surface,
  but still bounded to a smoke-level load/readiness proof. Rich multi-step
  product journeys remain the next adapter slice.
- The successful public runs still produced setup-quality feedback candidates
  for ceremonial setup. That signal should stay visible until actors reliably
  author high-leverage personas, scenarios, and feedback.
- The aggregate TodoApp/it-tools run proves top-level nested trace surfacing for
  both pass and fail lanes, but only TodoApp counted as one of the successful
  public target proofs.
