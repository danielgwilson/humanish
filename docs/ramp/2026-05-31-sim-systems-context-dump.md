# Sim Systems Context Dump For Mimetic CLI

Date: 2026-05-31

Audience: a fresh Codex session with amnesia that needs to continue extracting
`mimetic-cli` from the three existing simulation systems.

This is intentionally long and uneven. It preserves details that may later prove
irrelevant because the failure mode for this work is not "too much context"; it
is rebuilding from scratch, omitting the bed, or silently reintroducing product
cruft into a generic harness.

## Source Truth Snapshot

Source repos inspected in this ramp:

| System | Local path | Commit/status observed |
| --- | --- | --- |
| NoBG | `/Users/danielgwilson/local_git/nobg` | `363197221dd69cd5d097e7cfc4d6e8391954bb3e` on clean `main...origin/main` |
| Northstar | `/Users/danielgwilson/local_git/legionhealth/northstar` | `ed1b0242ce122b5a220e8ee1f65b5a110e231615` on clean `main...origin/main` |
| Image Skill | `/Users/danielgwilson/local_git/genskill/image-skill` | `1513260e7ba1cdbc167d75fbf2d553566c432668` on `main...origin/main` with untracked `docs/harness/rollups/` |
| Mimetic CLI | `/Users/danielgwilson/local_git/mimetic-cli-repo/mimetic-cli` | `72187863f2e981bfec9fe089d84a1e33d9638671` before this dump |

Important caveat: these are live local snapshots. Northstar and Image Skill move
fast. Re-fetch before claiming current project status in a later session.

## One-Sentence Mental Model

Northstar `ui-sim` is a browser/desktop multi-app E2B simulation harness. NoBG
`ui-sim` is that same harness trimmed down to a one-app product-flow simulator.
Image Skill `sim` is not the same codebase, but it carries the same doctrine
into real-agent public-product studies: artifact bundle first, observer second,
failure owner explicit, product boundary protected.

`mimetic-cli` should extract the shared substrate:

```text
intent -> scenario/profile -> isolated execution -> durable run bundle
-> review packet -> observer/mission control -> next product action
```

It should not extract Northstar patient nouns, NoBG image nouns, or Image Skill
private product assumptions into core.

## The NoBG Port: What Actually Happened

The NoBG work started from a user request to literally copy Northstar
`packages/ui-sim` and chop it down, explicitly not rebuild from scratch. That
constraint mattered. Copying first preserved a lot of hidden bedrock:

- run/artifact layout;
- E2B lifecycle types;
- prepared runtime/snapshot model;
- source archive and transfer utilities;
- observer shell and view model;
- per-sandbox session artifacts;
- action trace and screenshot capture;
- run-level and sandbox-level review packet shape;
- history/latest/index model;
- preflight and doctor surfaces;
- computer-use actor scaffolding;
- Codex/terminal actor scaffolding;
- dry-run as artifact contract proof;
- live mode as E2B fanout proof.

The port landed in NoBG as PR #33:

- merge commit: `3631972 Add NoBG ui-sim harness (#33)`;
- feature commit before squash: `512d6cd Add NoBG ui-sim harness`;
- package path: `/Users/danielgwilson/local_git/nobg/packages/ui-sim`;
- root command: `pnpm ui-sim`;
- package-local checks: `pnpm ui-sim:typecheck`, `pnpm ui-sim:test`;
- root `check:fast`: now includes NoBG app lint/typecheck, ui-sim typecheck,
  ui-sim tests, and swarm readiness.

### NoBG Port File Shape

NoBG retained almost the same source file graph as Northstar. A quick source
tree comparison showed only these Northstar `src` files were removed entirely:

- `src/runtime/verified-emulator-server.ts`;
- `src/supported-persona-addresses.ts`.

Everything else was conceptually retained and edited:

- `src/artifacts.ts`;
- `src/cli/main.ts`;
- `src/cli/options.ts`;
- `src/computer-use.ts`;
- `src/config.ts`;
- `src/e2b/*`;
- `src/history/*`;
- `src/observer/*`;
- `src/preflight.ts`;
- `src/review-artifacts.ts`;
- `src/run-review.ts`;
- `src/runtime/*`;
- `src/scenario-*`;
- `src/source/*`;
- `src/terminal-agent.ts`;
- `src/types.ts`.

NoBG now has one big contract test instead of Northstar's broad test suite:

- NoBG: `packages/ui-sim/tests/nobg-contract.test.ts`;
- Northstar: 23 package test files;
- NoBG: 1 package test file with 19 tests;
- Image Skill sim/persona: 2 main test files under `tests/agent-study-sim` and
  `tests/persona-simulation`.

This is important for extraction. NoBG is proof that a product adapter can be
made by reducing the domain surface, but it is not yet proof that the generic
substrate is naturally modular. The NoBG package still contains lots of copied
source, with product-specific edits threaded through generic files.

### What Was Removed For NoBG

Explicitly removed or neutralized:

- Northstar patient/provider/admin app topology;
- patient synthetic identity;
- supported persona addresses;
- Verified API emulator;
- Verified env variables;
- sandbox database modes, migrations, seed, Postgres, Docker, compose checks;
- Northstar patient onboarding milestones;
- command-center/patient profile names;
- Northstar docs like observer UX QA;
- Bun runtime assumptions;
- Bun package scripts and `bunfig.toml`;
- generated or copy-pasted test suite that asserted Northstar behavior.

NoBG-specific runtime is single-app:

```text
web -> http://localhost:3000
warm routes -> /, /studio, /pricing
sandbox repo path -> /home/user/nobg
sandbox temp path -> /tmp/nobg-ui-sim
template -> nobg-ui-sim-base
```

The NoBG env surface is much smaller:

- `UI_SIM_TEMPLATE_ID`;
- `UI_SIM_SNAPSHOT_ID`;
- `UI_SIM_PROOF_ROOT`;
- `UI_SIM_TARGET`;
- `UI_SIM_TARGET_URL`;
- `UI_SIM_WEB_BASE_URL`;
- `UI_SIM_E2B_LAUNCH_CONCURRENCY`;
- `UI_SIM_ACTOR`;
- `UI_SIM_ENV_FILE`;
- terminal/computer-use envs;
- explicit sandbox env JSON/prefix values;
- NoBG app env values forwarded only by allowlist.

### What Was Changed For NoBG

Package manager and runtime:

- Northstar uses Bun: `bun run src/cli.ts`, `bun run observer:build`.
- NoBG uses pnpm/tsx: `tsx packages/ui-sim/src/cli.ts`.
- NoBG observer asset build uses `esbuild` from Node, not Bun APIs.
- NoBG observer server uses Node `http` and `fs/promises`, not `Bun.serve`.
- `import.meta.main` was replaced with a Node-compatible
  `process.argv[1]`/`fileURLToPath(import.meta.url)` entrypoint check.

Root workspace integration:

- `pnpm-workspace.yaml` was expanded to include `.` and `packages/*`.
- root `tsconfig.json` excludes `packages/ui-sim` because the package has its
  own TS config with `allowImportingTsExtensions` and observer-client config.
- root `check:fast` explicitly runs the package gates so excluding it from the
  app `tsconfig` does not hide it.

Scenario profiles changed to:

- `default`: mobile upload, desktop upload, pricing/HD gate;
- `conversion-smoke-4`: default plus Studio route;
- `organic-upload-8`: seller/designer/developer oriented organic product
  research;
- `post-auth-return-1`: targeted post-auth/lost-upload/broken-image check.

The `post-auth-return-1` profile exists because the PostHog deep dive found a
real fragility: user uploaded/processed an image, hit HD download account gate,
created a GitHub account, returned to previous page, and saw a broken image /
missing upload state. NoBG `ui-sim` encodes that as a first-class scenario:

- start at `/studio`;
- act like a user who just returned from auth;
- inspect for broken image icons;
- inspect for empty-state/recovery affordance;
- inspect compare-slider mismatch and lost task context.

Run review counts changed to product-relevant counters:

- `uploadEntryReached`;
- `studioReached`;
- `downloadReached`;
- `authGateReached`;
- `brokenImageObserved`;
- plus generic app-load/artifact/E2B failure counts.

Preflight/doctor changed to product-neutral NoBG checks:

- target URL validity;
- E2B key presence for live mode;
- OpenAI key for computer-use actor;
- terminal command availability for Codex actor;
- sandbox env JSON validity;
- Node/pnpm/Chrome/noVNC/template-ish checks.

The cruft scan that mattered:

```bash
rg -n "Bun|northstar|Northstar|Legion|patient|provider|admin|clinic|appointment|scheduling|telehealth|hipaa|controlled-substance|Verified|VERIFIED|Postgres|BUN_INSTALL|\bbun\b|bun run|database-preparing|database-prepared" \
  packages/ui-sim/src packages/ui-sim/scripts packages/ui-sim/templates packages/ui-sim/docs packages/ui-sim/README.md \
  -g '!**/src/observer/generated/assets.ts'
```

and a second scan against generated observer assets. Both were clean before
merge. Later I had to remove even forbidden words from contract tests by
building the regex terms dynamically, because broad future scans should not
trip on tests that only assert legacy words are absent.

### NoBG Validation Run

Before merge:

- `pnpm check:fast` passed;
- `pnpm ui-sim --help` passed in the feature worktree;
- `pnpm ui-sim launch --dry-run --count 2 --run ui-sim-smoke` passed;
- `pnpm ui-sim review --run ui-sim-smoke --json` passed;
- Vercel passed on PR #33.

Current local caveat observed during this context dump:

- Running `pnpm ui-sim --help` in the canonical NoBG checkout failed because
  local dependencies were not installed/updated for the new workspace package:
  `Cannot find package 'esbuild' imported from packages/ui-sim/src/cli/observer-assets.ts`.
- This is likely a local `pnpm install` state issue, not a committed code issue,
  because the feature worktree had `pnpm install` run and all checks passed.
- A future session should run `pnpm install` in `/Users/danielgwilson/local_git/nobg`
  before testing NoBG `ui-sim` from the canonical checkout.

### Bugs/Pitfalls Hit During The NoBG Port

These are extraction-relevant:

1. Root CLI argument forwarding:
   - Initial nested `pnpm --dir packages/ui-sim` command made root argv messy.
   - Fixed by making root `ui-sim` call `tsx packages/ui-sim/src/cli.ts`
     directly.
   - Lesson: generic CLI should be directly runnable from host root without
     double `--` when possible.

2. Root TypeScript boundary:
   - Root app `tsconfig.json` tried to compile `packages/ui-sim` and exploded on
     package-specific `.ts` imports / observer-client settings.
   - Fixed by excluding `packages/ui-sim` from root app TS and explicitly adding
     package gates to `check:fast`.
   - Lesson: extracted `mimetic-cli` should carry its own package TS config and
     host integrations should opt into package checks explicitly.

3. Bun-to-Node conversion:
   - `Bun.serve`, `Bun.file`, and Bun's build API had to be replaced.
   - `import.meta.main` is not portable.
   - Lesson: generic core should not depend on Bun unless the package chooses
     Bun as its runtime. Node/tsx/esbuild is easier across NoBG/Image Skill.

4. Blob/buffer type mismatch:
   - E2B `sandbox.files.write` with `new Blob([archiveBytes])` hit a type issue
     after moving to Node.
   - Fixed by converting to `Uint8Array.from(archiveBytes).buffer`.
   - Lesson: abstract file upload behind a small helper; do not let substrate
     SDK blob quirks leak into product adapters.

5. Generated observer assets:
   - Northstar ignores generated assets, but NoBG committed
     `src/observer/generated/assets.ts` for convenience.
   - This is a policy decision to revisit. Generic `mimetic-cli` should likely
     choose one stable approach: generated artifact committed for package
     portability, or generated at test/runtime with clear checks.

6. Tests as cruft sources:
   - Even absent-word assertions can pollute text scans.
   - Use dynamic construction for forbidden legacy terms in tests if broad
     anti-cruft scans become a gate.

## Northstar Current Sim Status

Northstar has two distinct harness realities:

1. Broad repo doctrine says behavior-changing work should begin with a sim or
   scenario proof, and for chat/intake/refill the current actual behavioral
   harness is `chat-sim`.
2. `packages/ui-sim` is a mature browser/desktop simulation harness for
   patient/provider/admin UI and organic user tests.

Do not confuse these. For `mimetic-cli`, `packages/ui-sim` is the code source
worth extracting from. For Northstar product work, `chat-sim` may be the more
important current behavior proof lane.

### Northstar `packages/ui-sim`

Path:

```text
/Users/danielgwilson/local_git/legionhealth/northstar/packages/ui-sim
```

Current package shape:

- package: `@northstar/ui-sim`;
- runtime: Bun;
- root command: `bun ./packages/ui-sim/src/cli.ts`;
- package scripts:
  - `cli`;
  - `observer:build`;
  - `template:build`;
  - `manual:computer-use`;
  - `test`;
  - `typecheck`.

Command center:

```text
bun run ui-sim
bun run ui-sim -- swarm --count 16 --open
bun run ui-sim -- swarm --profile organic-patient-16
bun run ui-sim -- swarm --profile command-center-16 --patient-url ... --provider-url ... --admin-url ...
bun run ui-sim -- doctor --template northstar-ui-sim-base
bun run ui-sim -- prepare
bun run ui-sim -- review --run latest
bun run ui-sim -- cleanup --run latest
```

Apps:

- `patient` on `http://localhost:3000`;
- `provider` on `http://localhost:3100`;
- `admin` on `http://localhost:3200`.

Profiles:

- `default`;
- `command-center-16`;
- `organic-patient-16`;
- `patient-full-funnel-1`.

Runtime features:

- local mode packages current repo, uploads source to E2B, installs
  dependencies, prepares sandbox database, runs migrations/seeds, builds Next
  apps, starts app servers, warms routes, snapshots, and fans out desktops;
- external mode uploads harness source only, prepares agent runtime, snapshots,
  then points Chrome at configured public URLs;
- native/docker/auto/off sandbox DB modes;
- sandbox-local Verified HTTP emulator for deterministic patient onboarding;
- prepared runtime snapshots with fingerprint compatibility checks;
- computer-use actor inside the scenario sandbox;
- Codex/terminal actor;
- action trace before/after turns;
- browser diagnostics JSON/NDJSON;
- screenshots;
- lifecycle timing summaries;
- run-level and sandbox-level review packets;
- observer command-center with grid/focus/artifact panel;
- history index and latest run pointer;
- metadata-scoped cleanup.

Northstar's `README.md` says the observer is intentionally an artifact viewer,
not the source of truth. This is one of the most important extraction lessons:
humans watch the observer, agents review artifacts.

Artifact contract:

```text
artifacts/proof/<run-id>/ui-sim/
  run.json
  summary.md
  review.md
  review.json
  observer/
    index.html
    observer-data.json
  sandboxes/<sandbox-id>/
    review.md
    review.json
    session.json
    actions.ndjson
    scenario-action-plan.json
    console.log
    browser-diagnostics.json
    browser-diagnostics.ndjson
    screenshots/
```

Northstar product-specific assumptions that must not enter `mimetic-core`:

- patient/provider/admin app labels;
- synthetic patient identity;
- persona addresses;
- Verified emulator;
- healthcare onboarding milestones;
- database migrations/seeding as mandatory;
- Postgres/native/docker DB modes as core concepts;
- command-center patient profile names;
- any HIPAA/clinical wording;
- patient scheduling/intake/dashboard success semantics.

Northstar generic value that should enter `mimetic-cli`:

- artifact path builder;
- git state capture;
- source archive excludes;
- E2B sandbox adapter shape;
- prepared runtime cache/fingerprint shape;
- capability doctor pattern;
- lifecycle event stream;
- per-slot session artifact shape;
- action trace schema;
- browser diagnostics schema;
- observer data normalization;
- observer shell/grid/focus/artifact panel;
- run-review and sandbox-review rebuild discipline;
- history/latest/index;
- metadata-scoped cleanup;
- actor-mode split: scripted, computer-use, codex/terminal.

## NoBG Current Sim Status

Path:

```text
/Users/danielgwilson/local_git/nobg/packages/ui-sim
```

NoBG is the best source for understanding the first mechanical port from
Northstar into another product. It proves the copy-then-chop strategy works,
but it also proves why `mimetic-cli` should exist: all adapter/product concerns
are still interleaved through copied source files.

Current package shape:

- package: `@nobg/ui-sim`;
- runtime: Node/tsx/pnpm;
- root command: `pnpm ui-sim`;
- package scripts:
  - `cli`;
  - `observer:build`;
  - `template:build`;
  - `manual:computer-use`;
  - `test`;
  - `typecheck`.

Apps:

- `web` only, port `3000`.

Profiles:

- `default`: mobile upload, desktop upload, pricing/HD gate;
- `conversion-smoke-4`: default plus Studio route;
- `organic-upload-8`: product-intent exploration personas;
- `post-auth-return-1`: targeted broken image/lost upload after auth return.

NoBG-specific success/failure vocabulary:

- upload entry reached;
- studio reached;
- download reached;
- auth gate reached;
- broken image observed;
- app-load failure;
- artifact failure;
- E2B failure.

NoBG artifact contract is intentionally still Northstar-shaped:

```text
artifacts/proof/<run-id>/ui-sim/
  run.json
  summary.md
  review.json
  review.md
  observer/observer-data.json
  observer/index.html
  sandboxes/<sandbox-id>/
    session.json
    actions.ndjson
    review.json
    review.md
    screenshots/
    browser diagnostics when available
```

Good extraction signal from NoBG:

- `UiSimApp` reduced from `"patient" | "provider" | "admin"` to `"web"`;
- config reduced to `baseUrls.web`;
- DB/Verified identity entirely removable;
- scenario profile functions are adapter material;
- review milestone counts are adapter material;
- root command integration should be package-host agnostic;
- template name and runtime paths are adapter material;
- observer shell can remain generic while labels/counts change.

NoBG-specific assumptions that must not enter generic core:

- image upload/download workflow;
- HD/account gate language;
- `/studio` and `/pricing`;
- compare slider;
- broken image icon as a generic failure;
- Fal/Stripe/Auth/Supabase/PostHog env forwarding;
- `nobg-ui-sim-base`;
- `/home/user/nobg`.

## Image Skill Current Sim Status

Path:

```text
/Users/danielgwilson/local_git/genskill/image-skill
```

Image Skill is not a direct `ui-sim` copy. It is the conceptual sibling that
should strongly influence `mimetic-cli` because it generalizes from browser UI
simulation to real agent product simulation.

The root command is:

```bash
pnpm sim <command> [options]
```

It exists in:

```text
scripts/agent-study-sim/cli.mjs
```

Root package script:

```json
{
  "sim": "node scripts/agent-study-sim/cli.mjs",
  "swarm:readiness:check": "node scripts/check-swarm-readiness.mjs",
  "dev:harness": "tsx src/harness-cli.ts"
}
```

Current command surface:

- `doctor`;
- `prepare`;
- `run`;
- `watch`;
- `runs`;
- `show`;
- `open`;
- `review`;
- `verify`;
- `scenarios`;
- `agents`;
- `templates`;
- `cleanup`.

Notably, Image Skill deliberately does **not** use `swarm` or `launch` as sim
commands. Matrix/fanout belongs under `run --agents ...`; substrate detail
belongs under `run` and `prepare`. This is an important naming decision for
`mimetic-cli`: generic CLI should probably use Image Skill's command vocabulary,
not Northstar's `launch`/`swarm` vocabulary, unless preserving compatibility
aliases is valuable.

### Image Skill Has Two Sim Lanes

1. `persona-simulation`
   - fixture-first and hosted public CLI runner;
   - deterministic guardrail;
   - tests scorecard schemas, redaction, failure-domain separation;
   - can run hosted public CLI proof with explicit network opt-in;
   - not a real agent runtime by default.

2. `agent-study-sim`
   - real-agent user-study lane;
   - E2B as first substrate;
   - Codex as first runtime;
   - public Image Skill surfaces only;
   - real vague instructions;
   - optional capped media spend only with explicit flags;
   - run bundle is canonical;
   - observer is mission control projection.

### Image Skill Product Boundary

This is the strongest doctrine to preserve:

Simulated agents are external users. They may use:

- `https://image-skill.com`;
- `https://image-skill.com/llms.txt`;
- `https://image-skill.com/skill.md`;
- the public npm package `image-skill`;
- the hosted API.

They must not:

- clone or inspect the private repo;
- depend on local harness internals;
- receive private implementation docs;
- receive media provider credentials;
- receive payment/deploy/database/GitHub credentials;
- mutate GitHub directly as maintainers.

Executor credentials are separate from product credentials. For Codex-in-E2B,
`OPENAI_API_KEY` can be command-scoped into the Codex process via
`--runtime-auth openai-env`, but not placed in global E2B sandbox env,
metadata, prompts, transcripts, command logs, or review artifacts.

This split should become a first-class `mimetic-cli` concept:

```text
executor auth != product auth != provider auth != repo maintainer auth
```

### Image Skill Run Bundle

Canonical root:

```text
.image-skill/sim/proof/<run-id>/
```

Minimum bundle from docs/code:

```text
run.json
prompt.md
scorecard.json
defection-risk.json
cost.json
review.json
review.md
cleanup.json
setup/scenario-setup.json
substrate/lifecycle.ndjson
substrate/command-log.ndjson
terminal/raw.ndjson
terminal/normalized.txt
terminal/interventions.ndjson
agent/transcript.md
agent/agent-report.json
product/feedback-lifecycle.json
product/issue-promotion.json
media/media-proof.json
redaction/leak-scan.json
```

This is much more general than Northstar's browser/screenshot bundle. The
generic `mimetic-cli` artifact contract should probably converge more toward
Image Skill's bundle taxonomy, while supporting Northstar-style `screenshots`,
`browser-diagnostics`, and `session.json` as stream/evidence types.

### Image Skill Failure Taxonomy

Primary owner values:

- `product_ux`;
- `agent_runtime`;
- `executor_substrate`;
- `payment_provider`;
- `model_provider`;
- `harness`;
- `none`.

NoBG/Northstar have similar implicit ideas but Image Skill has the cleanest
taxonomy. `mimetic-cli` should adopt it, with adapter-extensible owner enums if
needed.

### Image Skill Progress Watchdog

Image Skill's `progress-watchdog.mjs` classifies durable terminal/product
evidence, not DOM movement:

- `completed`;
- `useful_evidence_before_failure`;
- `no_output`;
- `product_visible_friction`;
- `repeated_error_loop`;
- `product_progress`;
- `no_product_activity`.

Signals include:

- terminal heartbeat count;
- product command observed;
- hosted success observed;
- media observed;
- feedback observed;
- issue observed;
- final report observed;
- repeated error loops.

For `mimetic-cli`, this is the right conceptual model for non-browser actors.
Northstar's no-progress detection watches browser state; Image Skill's watches
terminal/product command state. Generic core needs progress detectors as
pluggable strategy per stream/actor, not one baked-in DOM assumption.

### Image Skill Observer / Mission Control

The docs explicitly say:

- run bundle is source of truth;
- observer is live projection;
- `watch` must update while the run is alive;
- terminal tile should feel like a real agent terminal;
- JSON is for CI/proof, not the default operator experience;
- browser/computer/VNC streams should extend the same command-center shell;
- operator input must be recorded as intervention and marks run assisted and
  non-comparable.

This is deeper than NoBG/Northstar's observer language and should guide
`mimetic-cli`'s future observer. The UI should be "agent mission control," not
"pretty JSON report."

Current Image Skill stream kinds:

- `terminal`;
- `summary`.

Future stream kinds:

- `browser`;
- `computer`;
- `vnc`.

### Image Skill Safety/Autonomy Standards

Image Skill has a swarm-readiness standard that matters because `mimetic-cli`
will likely become the substrate for self-driving issue execution:

- issues need an explicit readiness block before autonomous mutation;
- intake is permissive, execution is rigorous;
- authority values are distinct (`observe`, `draft_spec`,
  `draft_pr_docs_harness`, `draft_pr_product_code`, etc.);
- default-deny paths include `.env*`, workflows, infra, payment/auth/credential
  code, public contract files, lockfiles, broad refactors;
- controller/executor boundary: controller owns GitHub authority, executor runs
  scoped tasks and returns artifacts;
- proof artifacts must include changed files, credentials injected by name,
  commands and exit codes, leak scan, telemetry trace id, recommendation.

For `mimetic-cli`, this likely becomes either:

- an integration standard;
- a `mimetic issue-readiness` helper later;
- or at least an example of how run bundles should prove autonomy work.

## Cross-System Differences That Matter

| Dimension | Northstar `ui-sim` | NoBG `ui-sim` | Image Skill `sim` | Mimetic implication |
| --- | --- | --- | --- | --- |
| Product surface | Browser apps | Browser app | Public CLI/API/site used by agents | Core must not assume browser-only |
| Apps | patient/provider/admin | web | product surface abstractions | App topology belongs in adapter |
| Runtime | Bun | Node/tsx/pnpm | Node `.mjs` scripts | Core should be Node-first unless decided otherwise |
| Main command nouns | `swarm`, `launch`, `prepare`, `doctor`, `watch` | same as Northstar | `run`, `watch`, `doctor`, `prepare`, `verify` | Prefer Image Skill command nouns; maybe alias Northstar nouns |
| Artifact root | `artifacts/proof/<run>/ui-sim` | same | `.image-skill/sim/proof/<run>` | Core should let adapter set proof root and namespace |
| Evidence | screenshots, action traces, browser diagnostics | same, image-workflow vocabulary | terminal transcripts, product command ledgers, media proof, feedback proof | Evidence types should be stream modules |
| Actor modes | scripted, computer-use, codex terminal | same | Codex now; planned Claude/OpenClaw/Hermes | Actor runtime should be pluggable |
| Substrate | E2B Desktop | E2B Desktop | E2B real-agent sandbox; local fixture/hosted CLI | Substrate adapter distinct from actor/runtime |
| Observer | browser/desktop grid/focus/artifacts | same shell adapted | mission control terminal/summary streams | Observer shell can be shared; tiles/streams pluggable |
| Review | flow depth/milestones/failure domains | upload/studio/download/auth/broken-image | product UX/runtime/substrate/payment/model/harness | Review core plus adapter milestone extractors |
| Safety | source excludes, env controls, metadata cleanup | same reduced | public-product boundary, secret redaction, spend caps | Core must have credential and spend policy hooks |
| Current proof maturity | mature package with 23 tests | first port with 1 contract suite | rich docs and scripts, active work | Extract from all three, not only NoBG |

## Extraction Boundary Proposal

Do **not** start by making one giant package that directly imports the NoBG
package. The current copied packages are not modular enough. Start by defining
contracts and then extract stable slices.

Suggested package/workspace shape:

```text
mimetic-cli/
  packages/
    mimetic-core/
      artifacts/
      history/
      review/
      lifecycle/
      policy/
      schema/
    mimetic-cli/
      command parser
      command envelopes
      config loading
      run/watch/review/verify/open/runs
    mimetic-observer/
      stable shell
      stream/tile view models
      static asset build
    mimetic-e2b/
      E2B substrate adapter
      doctor/prepare/cleanup
      metadata/env allowlists
    mimetic-actors/
      terminal/codex/computer-use/scripted adapters
    adapters/
      nobg/
      northstar/
      image-skill/
  docs/
    contracts/
    ramp/
    decisions/
```

If monorepo overhead feels too early, keep a single package but still organize
source by these boundaries:

```text
src/core/
src/cli/
src/observer/
src/substrates/e2b/
src/actors/
src/adapters/
```

### Core Should Own

- run IDs;
- artifact path construction;
- schema versioning;
- history/latest/index/ledger;
- git/source state capture;
- redaction interfaces;
- leak scan interfaces;
- lifecycle events and timing summaries;
- run bundle verification;
- review packet selection/non-degrading rebuild;
- command result envelopes;
- policy objects for network/spend/credentials;
- generic failure-owner taxonomy;
- generic status model;
- plugin registries for adapters/actors/substrates/evidence streams.

### E2B Substrate Should Own

- dynamic E2B imports;
- sandbox creation;
- timeout and request caps;
- metadata allowlist validation;
- sandbox env allowlist validation;
- source archive upload/extract if a product adapter wants source upload;
- prepared snapshots/templates;
- sandbox lifecycle logs;
- command logs;
- noVNC/browser capability doctor where desktop substrate supports it;
- metadata-scoped cleanup.

### Observer Should Own

- stable command-center shell;
- grid/focus/artifact panel;
- stream kinds:
  - terminal;
  - browser;
  - vnc;
  - computer;
  - summary;
  - media;
  - cost;
  - review;
- static report rendering;
- local watch server;
- live-state refresh contract.

Observer should not own:

- product success semantics;
- run truth;
- artifact mutation beyond writing derived observer data/report files.

### Actor Runtime Should Own

- scripted browser action runner;
- OpenAI computer-use loop;
- Codex CLI/PTX/terminal runner;
- future Claude Code/OpenClaw/Hermes adapters;
- terminal raw/normalized/intervention artifacts;
- actor report shape;
- progress detection hooks.

Actor should not own:

- product-specific scenario success;
- credential policy decision;
- GitHub mutation authority.

### Product Adapter Should Own

- product name and artifact namespace;
- app topology;
- ports and warm routes;
- local runtime commands;
- external target URL names;
- environment variable allowlist;
- source archive include/exclude overrides;
- scenario profiles;
- personas;
- milestone extractors;
- review vocabulary;
- product-specific failure hints;
- scenario setup/fresh identity;
- product surface boundaries.

For example:

```ts
type MimeticAdapter = {
  id: string;
  displayName: string;
  artifactNamespace: string;
  appTopology: AppTopology;
  runtime: RuntimeAdapter;
  scenarios: ScenarioCatalog;
  milestones: MilestoneExtractor[];
  reviewVocabulary: ReviewVocabulary;
  policy: AdapterPolicy;
};
```

## Recommended First Extraction Path

Do not try to port all three systems at once. The highest-leverage path:

1. Write contracts first:
   - run bundle contract;
   - adapter contract;
   - actor contract;
   - substrate contract;
   - evidence stream contract;
   - review packet contract.

2. Extract pure core from NoBG/Northstar:
   - run ID;
   - artifact path builder;
   - git state;
   - history index;
   - lifecycle timing summary;
   - basic review packet types;
   - source archive excludes;
   - generic run manifest.

3. Build a small `mimetic` CLI skeleton:
   - `doctor`;
   - `run --dry-run`;
   - `review`;
   - `verify`;
   - `runs`;
   - `watch` as a static artifact viewer only at first.

4. Port NoBG as first adapter:
   - start with dry-run only;
   - prove same `post-auth-return-1` scenario manifest;
   - write artifacts matching current NoBG enough to compare;
   - keep current NoBG `ui-sim` untouched until parity exists.

5. Port Image Skill as second adapter:
   - use terminal/product evidence, not browser evidence;
   - prove `fresh-agent-discovery` dry-run bundle;
   - verify run bundle contract and review packet.

6. Only then touch live E2B:
   - E2B doctor;
   - source upload for NoBG/Northstar;
   - external public target for NoBG;
   - Image Skill E2B real-agent substrate.

7. Only after two adapters pass:
   - replace NoBG `packages/ui-sim` internals with `mimetic-cli`;
   - consider Northstar adapter;
   - leave product repos with thin adapter packages/scripts.

## Things I Found Valuable As An Agent

### Review Packet First

The difference between a usable sim and a log pile is `review.md`/`review.json`.
When a run fails, I want:

- verdict;
- failure owner;
- milestone statuses;
- deepest progress;
- recent actions/commands;
- key screenshots/transcripts;
- artifact pointers;
- next action.

I do not want to start from raw `actions.ndjson` or terminal chunks. The review
packet is the agent-readable abstraction over messy evidence.

### Durable Raw Evidence Under Derived Views

The review packet must be rebuildable from raw evidence:

- actions traces;
- browser diagnostics;
- terminal raw/normalized logs;
- command ledgers;
- screenshots/media proof;
- session/run JSON;
- leak scans;
- cleanup proof.

The observer is useful only because these artifacts exist. Without raw evidence,
the observer becomes vibes.

### Failure Owner Separation

When a sim fails, the key question is "whose failure is this?"

- app/product UX;
- agent runtime;
- executor substrate;
- harness;
- payment provider;
- model/media provider.

This separation prevents two common bad outcomes:

- product failures hidden as harness issues;
- substrate failures promoted as product feedback.

### Product Boundary

Image Skill's strongest idea is that simulated agents must behave like external
users. Do not give them private repo context if the product claim is public
discoverability. Do not give direct provider keys if the product claim is that
the product creates durable media. Do not let the executor become a privileged
maintainer.

This should be a generic `mimetic-cli` capability:

```text
scenario policy:
  product_surface: public | internal | local_source
  repo_access: none | read_only | workspace
  network: deny | allowlist | broad
  spend: disabled | capped
  credentials:
    executor: [...]
    product: [...]
    provider: [...]
```

### Prepared Runtime Is Optimization, Not Proof

Northstar prepared snapshots are valuable for speed, but they are not proof.
Proof is:

- what source/env/template fingerprint was used;
- what lifecycle events happened;
- what routes were warmed;
- what sandboxes were launched;
- what artifacts were written;
- what cleanup happened.

Do not let `snapshot exists` replace a run bundle.

### Dry-Run Is A Contract Test, Not A Product Test

NoBG dry-run does not prove product behavior. It proves:

- scenarios selected correctly;
- artifacts write correctly;
- review/observer data compiles;
- run manifest schema is stable;
- future live run will have a predictable proof shape.

This distinction should be explicit in review output. NoBG review categorizes
dry-run slots as `planned-no-browser-execution`.

### Anti-Cruft Scans Matter

When copying Northstar into NoBG, it was easy to leave invisible domain residue.
Broad string scans caught and prevented:

- patient/provider/admin words;
- Verified;
- Postgres;
- Bun;
- database lifecycle phases;
- Northstar/Legion labels.

For `mimetic-cli`, anti-cruft scans should check that core does not contain
product nouns except in adapter fixtures/docs.

### Local Tooling State Can Lie

NoBG merged clean and Vercel passed, but a later canonical checkout
`pnpm ui-sim --help` failed because local node_modules did not include the new
package dependency (`esbuild`). Future sessions should distinguish committed
repo state from local install state and run `pnpm install` after pulling
workspace/package changes.

## Open Uncertainties / Things To Recheck Later

- Northstar `ui-sim` is current on `main`, but Northstar product/harness truth
  also depends on Linear and active PRs. Re-ramp live before claiming current
  roadmap status.
- Image Skill has untracked `docs/harness/rollups/`; decide whether it matters
  before using that repo as fully clean source truth.
- NoBG canonical checkout needs dependency install before local `pnpm ui-sim`
  works.
- It is unclear whether `mimetic-cli` should support Bun at all in core, or
  merely allow adapters to call Bun runtime commands. My bias: Node/tsx core,
  adapter runtime commands can be Bun.
- It is unclear whether generated observer assets should be committed in
  `mimetic-cli`. NoBG committed generated assets; Northstar says generated
  assets are ignored/regenerated. My bias: if `mimetic-cli` is a package, commit
  built viewer assets only in release artifacts, not source, unless no build
  step is desired.
- It is unclear how much backward compatibility NoBG/Northstar should retain
  (`pnpm ui-sim`, `bun run ui-sim`, `swarm`, `launch`) once they use
  `mimetic-cli`. My bias: preserve product repo commands as thin aliases.
- It is unclear whether Image Skill's richer bundle should replace Northstar's
  artifact layout or coexist. My bias: define a generic run bundle with evidence
  directories (`browser/`, `terminal/`, `media/`, `computer/`, `review/`) and
  let adapters write compatibility projections.

## Concrete Next Session Starting Point

Start here:

1. Read this file.
2. Read `/Users/danielgwilson/local_git/mimetic-cli-repo/mimetic-cli/AGENTS.md`.
3. Inspect:
   - `/Users/danielgwilson/local_git/nobg/packages/ui-sim`;
   - `/Users/danielgwilson/local_git/legionhealth/northstar/packages/ui-sim`;
   - `/Users/danielgwilson/local_git/genskill/image-skill/scripts/agent-study-sim`;
   - `/Users/danielgwilson/local_git/genskill/image-skill/docs/harness/agent-study-sim`.
4. Create a worktree:

```bash
git -C /Users/danielgwilson/local_git/mimetic-cli-repo/mimetic-cli \
  worktree add ../worktrees/contracts -b codex/contracts
```

5. First implementation artifact should be docs/contracts, not code:
   - `docs/contracts/run-bundle.md`;
   - `docs/contracts/adapter.md`;
   - `docs/contracts/substrate.md`;
   - `docs/contracts/actor.md`;
   - `docs/contracts/evidence-streams.md`;
   - `docs/contracts/review.md`.

6. Then scaffold minimal package with tests around contracts.

Avoid the trap: do not start by building a shiny CLI from scratch. Extract the
bed first.

## Source Files Worth Opening First

Northstar:

- `packages/ui-sim/README.md`;
- `packages/ui-sim/src/types.ts`;
- `packages/ui-sim/src/artifacts.ts`;
- `packages/ui-sim/src/run-review.ts`;
- `packages/ui-sim/src/review-artifacts.ts`;
- `packages/ui-sim/src/e2b/real-adapter.ts`;
- `packages/ui-sim/src/e2b/prepared-runtime.ts`;
- `packages/ui-sim/src/observer/render.ts`;
- `packages/ui-sim/src/observer/client/view-model.ts`;
- `packages/ui-sim/src/scenarios.ts`;
- `packages/ui-sim/tests/*.test.ts`.

NoBG:

- `packages/ui-sim/README.md`;
- `packages/ui-sim/tests/nobg-contract.test.ts`;
- `packages/ui-sim/src/config.ts`;
- `packages/ui-sim/src/scenarios.ts`;
- `packages/ui-sim/src/run-review.ts`;
- `packages/ui-sim/src/runtime/commands.ts`;
- `packages/ui-sim/src/preflight.ts`.

Image Skill:

- `docs/harness/agent-study-sim/AGENTS.md`;
- `docs/harness/agent-study-sim/README.md`;
- `docs/harness/agent-study-sim/mission-control.md`;
- `docs/harness/agent-study-sim/northstar-ui-sim-transfer-2026-05-15.md`;
- `docs/harness/persona-simulation/README.md`;
- `docs/harness/persona-simulation/northstar-transfer.md`;
- `docs/plans/completed/017-persona-simulation-harness.md`;
- `docs/plans/active/021-e2b-real-agent-study-harness.md`;
- `scripts/agent-study-sim/cli.mjs`;
- `scripts/agent-study-sim/bundle-contract.mjs`;
- `scripts/agent-study-sim/review/packet.mjs`;
- `scripts/agent-study-sim/review/progress-watchdog.mjs`;
- `scripts/agent-study-sim/observer/*`;
- `tests/agent-study-sim/agent-study-sim.test.ts`;
- `tests/persona-simulation/persona-simulation.test.ts`.

## Commands I Ran During This Dump

Useful commands from this ramp:

```bash
git -C /Users/danielgwilson/local_git/nobg log --oneline -5 -- packages/ui-sim package.json
git -C /Users/danielgwilson/local_git/legionhealth/northstar log --oneline -8 -- packages/ui-sim package.json
git -C /Users/danielgwilson/local_git/genskill/image-skill log --oneline -8

find /Users/danielgwilson/local_git/genskill/image-skill -maxdepth 4 \
  -iname '*sim*' -o -iname '*swarm*' -o -iname '*harness*'

pnpm sim --help
pnpm ui-sim --help
bun ./packages/ui-sim/src/cli.ts --help

comm -23 <(find northstar/packages/ui-sim/src -type f ...) \
  <(find nobg/packages/ui-sim/src -type f ...)
diff -qr northstar/packages/ui-sim/src nobg/packages/ui-sim/src
```

Observed command outcomes:

- Image Skill `pnpm sim --help`: passed.
- Northstar `bun ./packages/ui-sim/src/cli.ts --help`: passed.
- NoBG `pnpm ui-sim --help`: failed in canonical checkout due local missing
  `esbuild`; run `pnpm install` before testing.

## Final Bias

The generic thing is not "UI sim." The generic thing is mimetic product
simulation:

```text
Can a realistic actor, in an isolated environment, using only the intended
surface and credentials, accomplish or evaluate a real product task, and leave
behind enough durable evidence for another agent to decide what to do next?
```

That should be the north star for `mimetic-cli`.
