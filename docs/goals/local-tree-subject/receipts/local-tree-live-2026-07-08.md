# Live rung receipt: local-tree subject, 2026-07-08

One live single-lane run of a `subject.source: local-tree` lab against a
synthetic fixture app, from a deliberately dirty working tree, on the
`feat/local-tree-subject` branch (PR #265).

## Setup

- Fixture: a synthetic single-file python3 task board (stdlib `http.server`,
  loopback port 3000) in its own scratch git repository. Public-safe by
  construction; no real user data anywhere.
- The tree was made dirty on purpose before packing: one committed baseline,
  then an uncommitted edit to a tracked file plus one untracked (not ignored)
  file. A planted `.env` and a gitignored log file were present to exercise
  the exclusion behavior.
- Lab manifest: `subject.source: local-tree`, `serve.start: python3
  server.py`, loopback readiness URL, `execution.target: e2b-desktop`,
  one `openai-computer-use` actor with a bounded 120s session budget,
  `scenario.mode: live`.

## Result (kept run id: `cua-2026-07-08T18-58-56-027Z-082c1b59`)

- Enumeration packed 5 entries: the tracked files, the uncommitted edit, and
  the untracked file. The planted `.env` and the gitignored log never
  enumerated (observed directly via `enumerateLocalTree` on the same tree).
- Bundle subject provenance:
  - `source: local-tree`
  - `archiveSha256: 1e1b8eb10ed03bcb92a3438898cccc6deb5eea08e2f1b06972aa9bc48d5b0069`
  - `commit: 90e3ab0ee167ffa13dd7d9a322b7a9a92381840c` (fixture HEAD at pack time)
  - `dirty: true`
- **Pin recomputability:** running `createLocalTreeArchive` on the same
  unchanged tree after the run reproduced the identical `archiveSha256`
  (exact 64-hex match) and the identical `commit`/`dirty` capture.
- Actor session completed with `completionReason: goal_satisfied` (the
  computer-use actor added a task through the packed app's real UI).
- Sandbox reclaimed by id (`killed: true`).
- `homun verify --run latest`: ok, 15/15 checks passed,
  `shareSafety.status: local_only` (expected: full-fidelity screenshots stay
  local; no public-safety findings).

## Digest sensitivity, observed live

An earlier rung the same day accidentally mutated the tree during packing
(shell output redirection had created result files inside the fixture root),
and the recorded pin differed from a later recompute of the changed tree.
That divergence is the digest working as designed: the pin is
content-sensitive, and any mutation of the packed tree produces a different
`archiveSha256`. The clean rung above used run outputs outside the tree and
recomputed to an exact match.

## Spend and reclamation

Single lane, one hosted desktop, bounded 120s session budget; the sandbox
was killed by id at teardown in both rungs. Raw evidence bundles remain in
the local ignored `.homun/` of the scratch fixture and are not committed.
