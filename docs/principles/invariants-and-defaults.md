# Invariants and Defaults

Mimetic's safety and honesty rules come in exactly two strengths. Confusing them is how
harnesses rot: a route-scoped default gets written down as if it were doctrine, then the next
legitimate use case looks like a violation and either gets blocked (capability loss) or
waved through ad hoc (safety loss). This page is the boundary.

## Invariants

True on every route, enforced in code, never overridable by config. A feature that cannot
satisfy these does not ship; a third-party extension that cannot satisfy these does not
certify (see the conformance suite).

1. **Secret values never reach PUBLISHED evidence.** No key, token, credential value, or
   session-secret may appear in any artifact that leaves the operator's machine — a committed
   file, a shared bundle, a feedback issue. Names of provisioned environment variables are
   evidence; their values never are. Harness-level errors pass through redaction before
   persisting, because SDK error strings can echo secrets. The enforcement point is the
   PUBLISH/VERIFY boundary, not capture: a local run's text artifacts are scrubbed of
   secret-shaped values unconditionally, and raw screenshots (which may render on-screen
   content) are retained locally under gitignored `.mimetic/` and never emitted by a publish
   command (feedback/review carry path strings, not pixels). In this repo the CI binary-asset
   scan additionally blocks them from commit; downstream projects do not get that scan — their
   protection is the init-scaffolded `.gitignore` plus their own review. To share a bundle
   as-is, set `policies.redactScreenshots: true` (blurs
   at capture); a redact-on-export step for already-captured raw bundles is planned, not yet
   shipped. (See "the capture-vs-publish rule" below — blurring frames at *capture* was a
   default mistaken for this invariant.)
   - Scope note: the literal scrub of KNOWN provisioned values runs on harness log-tails,
     errors, AND model-authored narration (reasoning/message) before it persists; secret-SHAPED
     values are caught everywhere by pattern redaction. The text artifacts are local
     (gitignored) regardless.
2. **Actors only drive harness-minted URLs.** A model with input control (mouse, keyboard,
   terminal) is only ever pointed at a URL the harness itself issued or validated under a
   declared policy (loopback entry, provisioned subject, declared external target). Never an
   arbitrary URL from unvalidated input.
3. **Live spend is explicit.** No configuration default, omission, or fallback may cause
   provider or sandbox spend. Spend requires an affirmative declaration (`scenario.mode:
   live`, an env opt-in gate for spend-bearing tests).
4. **Evidence verifies fail-closed.** A run bundle that cannot pass verification (schema,
   redaction status, artifact presence, public-safety scan) is a failed run, even when the
   session "worked." The gate applies to the harness's own error reports.
5. **Provenance is recorded or its absence is declared.** Every bundle states what the
   subject was (commit, image, fixture, or an explicit "unpinned" marker). Evidence that
   cannot say what it measured cannot support a decision.
6. **Claims match mechanism.** A config field that is parsed but not consumed warns; a
   document that overstates behavior is a defect; an evidence artifact never claims a
   stronger evidence class than its actor and scenario can support.

## Defaults

Right most of the time, overridable with declared friction (an explicit config field, an
env gate, a warning in the run output). Overriding a default is a supported use case;
silently drifting from one is not.

| Default | Why it is the default | Legitimate override |
|---|---|---|
| Dry-run | Spend safety (invariant 3 sets the floor; dry-run keeps the floor far away) | `scenario.mode: live` |
| Per-lane worlds | Isolation, attribution, reproducibility | `subject.topology: shared-world` — N seats against ONE provisioned, mutable plane for scenarios that ARE about interaction between roles (#164). `execution.concurrency: 1` (default) = SEQUENTIAL turns (one sandbox); `> 1` = CONCURRENT (one getHost-exposed subject sandbox + N actor sandboxes driving it at once, synthetic-subject only). The bundle declares the weaker `attributionClass: shared-world` + a verify-enforced `attributionLimits` ceiling (the concurrent set drops `sequential-only` and adds `best-effort-causal-attribution` etc.), so the looser per-role attribution is honest, not hidden. |
| External key placement | Smallest blast radius: when the keyed process (e.g. a computer-use provider loop) runs outside the sandbox, its key never enters | In-sandbox placement when the keyed process runs inside (an agent harness under test); declared per actor type, with a spend budget |
| Loopback entry URLs | Public-safety: never drive third-party sites unbidden | `policies.allowPublicTargets` for an owner-declared deployment/preview (a Vercel preview of your own app). Multi-lane public/preview fan-out needs explicit `actors[0].lanes[].target` for every lane, so the adapter-owned topology is declared rather than inferred. Provisioned clone subjects always serve in-sandbox on loopback |
| Full-fidelity screenshots, local | The common case is watching a sim of your OWN app locally; blur destroys the deliverable. Raw frames live in gitignored `.mimetic/` (this repo's CI adds a binary-asset commit scan; downstream projects rely on the scaffolded `.gitignore` and their own review) | `policies.redactScreenshots: true` blurs at capture for share-as-is bundles (a redact-on-export step for raw bundles is planned) |
| Synthetic, seeded state | Pinned provenance; no real user data in evidence paths | Declared external state, recorded as UNPINNED in provenance |
| Single lane | Cost + evidence simplicity | Declared fan-out where the backend supports it — `actors[0].count: N` (homogeneous), explicit `actors[0].lanes[]` (differentiated persona/device/instruction), or compact `actors[0].roster[]` groups that normalize into lanes on the computer-use E2B route (per-lane worlds, cap 16; `execution.concurrency` bounds concurrent paid lanes) |
| Stock `desktop` template | The stock E2B desktop image is right for most subjects; absent `execution.desktop.template` keeps `Sandbox.create(opts)` byte-stable | `execution.desktop.template` names a custom E2B desktop image (any name/id, no allowlist) for a subject needing baked-in runtimes the stock image lacks (e.g. node/bun/a local Postgres) — threaded to `Sandbox.create(template, opts)` on every desktop-creating route and recorded in the bundle as `desktopTemplate` (public-safe) |
| Desktop default URL opener | Preserve the route/image's historical browser/default opener behavior when unset | `execution.desktop.browser: chrome | chromium | firefox` makes hosted CUA/shared-world browser choice explicit, fail-closed, and recorded as `desktopBrowser` in the run bundle |

## The placement rule (worked example)

"No environment variables enter the sandbox" was once stated as a rule. It is not one — it
is the external-placement *default* as instantiated on the computer-use route, where the
model's brain runs outside the sandbox. The underlying invariant-level principle is:

> **Keys live where the keyed process runs — and nowhere else. Names go in evidence; values
> never. Blast radius is bounded by key scoping and budgets, not by hoping.**

Consequences:

- A computer-use provider loop runs outside → forwarding env into its sandbox is rejected.
- A subject app (a real web app under test) runs inside → its declared env names are
  provisioned in, values never persisted.
- An agent harness under test runs inside with real keys → that is the point of the lab;
  the keys are presumed exfiltratable by the agent (sandboxing does not protect them — key
  scoping and spend budgets do), and the lane carries a budget/ledger.

Placement is registry metadata per actor type, enforced by the engine — not a vibe.

Two corollaries:

- **Serve commands are author-trusted.** A lab's `serve` steps execute inside the disposable
  sandbox with the declared subject env present — the same trust class as the repo's own
  package.json scripts. Run only lab configs you trust; declare only the env names the
  subject genuinely needs.
- **Pattern redaction is not enough for provisioned values.** A provisioned value (a database
  password, an arbitrary token) has no detectable "shape," so the harness scrubs every value
  it provisioned by LITERAL match before any log tail or error can persist — pattern-based
  redaction is the second pass, not the only one.

## The capture-vs-publish rule (worked example)

"Every screenshot is blurred to a 128px thumbnail" was once enforced at *capture* — the
loop never retained a usable frame. That destroyed the core deliverable for the common case
(a developer watching a sim of their OWN app locally) to defend against a leak that can only
happen at *publish*. The proof it was a default, not an invariant: the same product already
shipped raw full-resolution frames on the meta route with only a "do not publish" warning +
the `.mimetic/` gitignore + the binary-asset scan. Two routes, opposite policies, identical
threat. The corrected principle:

> **A default's enforcement point belongs at the PUBLISH/VERIFY boundary, never at
> CAPTURE/RUNTIME — unless capture-time is the only physically possible point.**

Consequences:

- Screenshots are retained **raw and full-fidelity** by default, in gitignored `.mimetic/`.
  `policies.redactScreenshots: true` blurs at capture for a share-as-is bundle; a
  redact-on-export step for already-captured raw bundles is planned (not yet shipped). The
  frame sent to the provider is always raw regardless — the model must see the screen to act.
- The loopback wall and the synthetic-data stance were the same error: enforcing at
  capture/runtime (rejecting a public target outright; banning realistic local input) what
  belongs at publish (an owner-declared `allowPublicTargets`; redaction at the publish step). A genuine
  capture-time invariant — shell-injection shape checks, id-shape validation — passes the test
  because capture *is* the only point it can hold.

Litmus: for any constraint, ask "is this true everywhere, or true by default? — and if a
default, is it enforced at the boundary where the risk is actually realized?"
