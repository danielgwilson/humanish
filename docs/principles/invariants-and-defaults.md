# Invariants and Defaults

Mimetic's safety and honesty rules come in exactly two strengths. Confusing them is how
harnesses rot: a route-scoped default gets written down as if it were doctrine, then the next
legitimate use case looks like a violation and either gets blocked (capability loss) or
waved through ad hoc (safety loss). This page is the boundary.

## Invariants

True on every route, enforced in code, never overridable by config. A feature that cannot
satisfy these does not ship; a third-party extension that cannot satisfy these does not
certify (see the conformance suite).

1. **Secret values never reach evidence.** No key, token, session content, or credential
   value may appear in any persisted artifact (run bundle, review, events, traces,
   screenshots, logs) or in any committed file. Names of provisioned environment variables
   are evidence; their values never are. Harness-level errors pass through redaction before
   persisting, because SDK error strings can echo secrets.
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
| Per-lane worlds | Isolation, attribution, reproducibility | Shared-world topology for scenarios that ARE about interaction between personas |
| External key placement | Smallest blast radius: when the keyed process (e.g. a computer-use provider loop) runs outside the sandbox, its key never enters | In-sandbox placement when the keyed process runs inside (an agent harness under test); declared per actor type, with a spend budget |
| Loopback entry URLs | Public-safety: never drive third-party sites | Provisioned subjects (the harness serves the app and mints the URL); explicitly declared external targets owned by the lab author |
| Synthetic, seeded state | Pinned provenance; no real user data in evidence paths | Declared external state, recorded as UNPINNED in provenance |
| Single lane | Cost + evidence simplicity | Declared fan-out where the backend supports it |

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
