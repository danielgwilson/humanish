# Goal: the clone subject provider (layer 1 of the proof roadmap)

Status: shipping as 0.5.0. Scope carved from docs/goals/proof-roadmap/goal.md layer 1.

## What

`subject.source: clone` becomes a real subject for the computer-use route: the lab clones a
declared repo INTO the desktop sandbox, installs/builds/starts it from config-declared
commands, probes readiness, and only then lets the actor drive it — replacing the
`prepareDesktop`-only story with a config-only path.

```yaml
subject:
  source: clone
  repos: [example-org/example-app]     # exactly one for this route
  clone: { depth: 1 }                  # consumed here (was forward-declared)
  serve:
    install: pnpm install --frozen-lockfile   # optional, bounded
    build: pnpm build                         # optional, bounded
    start: pnpm start                         # required, long-lived (detached)
    url: http://127.0.0.1:3000/               # loopback-only; the harness-validated entry
    readyTimeoutMs: 180000                    # optional probe budget
  env: [DATABASE_URL]                  # subject-env channel: NAMES from --env-file
actors:
  - type: openai-computer-use
execution: { target: e2b-desktop }
scenario: { mode: live }
```

## Routing

`clone × e2b-desktop` now disambiguates on the actor lane (the axis doctrine: subject ×
execution selects the substrate; the actor selects what runs inside it):

- actor resolves to a computer-use descriptor → the cua backend (this provider);
- anything else → the meta backend, byte-for-byte unchanged.

`app-url` subjects are unchanged (the degenerate provider: the caller minted the URL).

## The detached-run primitive

E2B foreground commands deadline on long-running processes; at least three bespoke
implementations of the same workaround exist in the wild (nohup+status polling+heartbeat,
setsid+probe). This PR lands the primitive ONCE in the substrate (src/e2b-detached.ts):

- scripts are written via `files.write` (no heredocs — eliminates the sentinel-collision
  bug class by construction);
- bounded steps (install/build) run detached with an atomically-written status file,
  polled by short foreground commands; timeout kills the process group and surfaces a
  capped, redacted log tail;
- long-lived steps (start) launch fully detached (`setsid -f`) and are owned by the
  sandbox lifecycle (kill-on-timeout reclaims them);
- readiness is an explicit curl probe against the declared URL.

## Env placement (per the invariants-and-defaults doctrine)

- The subject app's declared env NAMES are provisioned into the sandbox at create time —
  values come from the caller's environment (`--env-file`), are never logged, never
  persisted, and never appear in scripts (scripts reference `$NAME`; resolution happens
  in-sandbox). Missing declared names fail closed before any sandbox exists.
- Private-repo auth: if `GITHUB_TOKEN` is among the declared names, the clone uses an
  authorization header sourced from the in-sandbox env — the token is never written into
  the clone URL, the script text, or `.git/config`.
- The computer-use actor's key still NEVER enters the sandbox (external placement,
  unchanged from 0.4.0). On this route the only env inside is what the config declared.

## Provenance (invariant 5)

The bundle records what the subject WAS: repo slug, cloned commit SHA, and declared env
names — as a provenance event, in the stream state, and in review.md.

Retired caveat (was: "this provider pins the code, not the database"): `subject.state` now
gives the state story a mechanism. Seed/migration/fixture steps declared under
`subject.state.seed[]` run in-sandbox around the serve sequence and are recorded as
structured provenance (marker `seeded`, sha256-16 command digests — never command text);
declared external state (`subject.state.external[]`, names backed by `subject.env`) is
recorded as UNPINNED; dry-run and failed provisioning record `declared-not-run`; everything
else is explicitly `undeclared`. `humanish verify` fail-closes on state claims that do not
match the recorded evidence. Snapshot memoization of seeded state remains a later layer.

## Out of scope (deliberate, per roadmap layer order)

- `reuse: snapshot` memoization (layer 3); multi-lane fan-out; shared-world topology
  (layer 6); in-sandbox actor key placement + budgets (layer 4); non-GitHub remotes.

## Proof

- Deterministic: detached-primitive unit tests (script content, atomic status, timeout
  kill, log-tail capping); config validation matrix (serve required on cua-clone, loopback
  url, env-name shape, single repo); routing matrix including clone×e2b-desktop×codex →
  meta unchanged (golden suite green); full clone-route fakes test through runLab driving
  the real loop/provider/executor (command sequence, env provisioning equals declared
  names exactly, token never in script text, provenance recorded, values absent from all
  artifacts); engine re-enforcement of loopback on serve.url.
- Live (spend-gated): a lab config cloning a small public static-site repo, served
  in-sandbox by the provider, driven by the real actor — verified bundle with provenance.
