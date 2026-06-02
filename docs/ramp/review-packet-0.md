# Review Packet 0

Date: 2026-06-02

Status: public-safe operator packet for Mimetic's first autonomous OSS lab
loop.

## Boundary

This packet uses only public-safe summaries, public GitHub metadata, committed
repo docs, command results, and local ignored artifact paths. It does not copy
secret values, sandbox ids, auth-bearing stream URLs, raw screenshots, raw
transcripts, private source-system artifacts, or target OSS source snippets.

## Verified Current State

Repository:

- repo: `danielgwilson/mimetic-cli`
- local main anchor:
  `/home/azureuser/claude/mimetic-cli-repo/mimetic-cli`
- worktree root:
  `/home/azureuser/claude/mimetic-cli-repo/worktrees`
- current main: `877ecbc Define policy boundary contract (#52)`
- open PRs: none, as reported by `gh pr list --state open`

Recent accepted sequence:

- `#39` added Codex exec fanout.
- `#40` published live Codex exec Observer snapshots.
- `#41` classified OSS meta-lab terminal failures.
- `#43` completed trusted Codex TUI actor runs.
- `#44` published Codex TUI running Observer snapshots.
- `#46` exited successful live JSON OSS meta-lab results.
- `#47` added core run primitive contracts.
- `#48` added the autonomous OSS lab runbook.
- `#50` exited failed live JSON OSS meta-lab results.
- `#51` defined the contract schema index.
- `#52` defined credential/network/spend/redaction/assisted-run policy.

Issue state after this packet was drafted:

- open: `#9` adapter terminal/product evidence fixture parity.
- open: `#8` adapter dry-run fixture parity for post-auth-return evidence.
- open: `#2` this review packet.
- closed during this loop: `#1`, `#3`, `#4`, `#6`, `#11`, `#28`, `#35`,
  `#36`, `#45`, `#49`.

Control-plane labels are present for:

- authority: observe, draft spec, draft PR docs/harness, draft product code,
  blocked;
- areas: contracts, CLI, core, Observer, actors, E2B substrate, adapters,
  GitHub feedback, docs;
- proof: contract fixture, dry-run artifact, live E2B, feedback loop,
  Observer;
- risk: low, medium, high, credential boundary, GitHub mutation;
- next step: implement, spec, verify, park.

GitHub Projects:

- `mimetic-cli` exists and is open.
- Other owner projects exist, but this packet treats GitHub Issues and PRs as
  canonical repo control-plane state.

## Verified Proof From This Loop

Baseline and lab proof on current-session worktrees:

- `pnpm check` passed after #47 in the core-primitives branch.
- `pnpm public-surface:scan` passed after each docs/code slice.
- `pnpm mimetic -- doctor --json` passed in `post-runbook-proof`.
- `pnpm mimetic -- lab oss --dry-run --json --no-open --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid --run-id oss-dry-after-runbook` returned `ok: true`.
- `pnpm mimetic -- verify --run oss-dry-after-runbook --json` passed 5/5 checks.
- `pnpm mimetic -- watch --run oss-dry-after-runbook --detach --json --no-open` returned `ok: true`.
- `pnpm mimetic -- lab oss-smoke --json --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid` returned `ok: true` for 4/4 disposable public clones.
- A live OSS lab run, `oss-live-after-runbook`, produced a failed but valid
  bundle and revealed #49. The issue was fixed by #50.

Remote CI:

- PRs #47, #48, #50, #51, and #52 passed CI on Node 22.14.0 and Node 24.

## Source-System Lessons

Verified:

- The repo has a clear public boundary in `AGENTS.md`, `README.md`,
  `SECURITY.md`, GitHub templates, release docs, architecture docs, and
  contract docs.
- `docs/operations/autonomous-oss-lab-loop.md` is now the stable long-running
  goal/runbook reference.
- `docs/contracts/schemas.md` defines the cross-contract ownership map and
  public-safe fixture examples.
- `docs/contracts/policy.md` separates executor, product, provider, and
  maintainer credentials and marks assisted runs non-comparable.
- Live OSS lab evidence can discover real harness bugs. In this loop it found
  the failed-result JSON exit gap that became #49/#50.

Inferred direction:

- Adapter parity work should now proceed as contract fixtures before broad
  implementation because public boundary, doctrine, core contracts, and policy
  contracts are in place.
- The remaining adapter issues should avoid private product examples and should
  model only fixture-equivalent evidence shapes.
- Wiring `src/core` primitives into emitted run bundles is a likely next
  implementation issue, because current bundles still have older source/git
  placeholders in some paths.

## Gaps Before Next Implementation

- `#8` and `#9` are adapter-specific and still `next:spec`; they need
  public-safe fixture contracts before product-like behavior is implemented.
- Current run bundles have core git-state primitives available, but not every
  bundle builder emits the new `mimetic.git-state.v1` shape yet.
- The live OSS lab depends on provider substrate availability. Provider launch
  failures should be classified as substrate evidence, not target repo failure.
- Local ignored run artifacts are useful for maintainers, but public issue and
  PR comments must continue to omit sandbox ids, auth-bearing stream URLs,
  screenshots, raw logs, and raw transcripts.

## First Implementation Sequence

Recommended next sequence:

1. Close this packet with proof.
2. Spec `#8` as a dry-run fixture contract under public-safe adapter
   boundaries.
3. Spec `#9` as terminal/product evidence fixture parity under the same
   boundaries.
4. Open a new implementation issue to wire `src/core` git-state/artifact
   primitives into emitted run bundles once adapter specs are stable.
5. Rerun OSS dry-run, smoke, and live lab after each harness implementation
   change that touches Observer, run bundle, or lab lifecycle behavior.

## Proof Commands

```bash
git diff --check
pnpm public-surface:scan
```
