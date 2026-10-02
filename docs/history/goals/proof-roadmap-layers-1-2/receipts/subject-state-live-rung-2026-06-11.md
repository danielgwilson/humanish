# Receipt: subject.state live rung (slice 1 of the layers 1–2 packet)

Date: 2026-06-11. Tree: main @ 535ea9e (#145 merged). Operator: maintainer session.

Command: `HOMUN_LIVE_CUA=1 npx vitest run tests/cua-actor-lab.state.live.test.ts`
Result: **1 passed / 0 failed, 24.2s** (real E2B sandbox + real OpenAI actor).

What the rung proves, by construction:
- The lab cloned a public repo and ran a `before-start` seed step whose output file IS
  the readiness-probe target (`serve.url` points at `seeded.html`, which exists only
  because the seed ran) — readiness passing is mechanical proof the seed executed.
- The real actor then drove the served, seeded page to a terminal session with no
  harness error; the sandbox was reclaimed.
- The persisted bundle recorded `subject.state.provenance: "seeded"` with the step's
  sha256-16 command digest and `ok: true`; the bundle contained the digest but NOT the
  command text; `verifyRun` passed including the new `subject state provenance` check.

Honest scope: the test's temp working dir is removed by its own cleanup, so the bundle
is not retained — this receipt plus the asserted test (committed in #145) is the kept
evidence, per the AGENTS.md receipt norm.
