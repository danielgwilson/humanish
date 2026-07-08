# Live rung receipt: homun packs and drives itself, 2026-07-08

The self-driving rung: `homun lab run` from this repository's own working
copy, with `subject.source: local-tree`, packs the checkout, uploads it into
one hosted desktop sandbox, serves the committed fixture app
(`homun/fixtures/shared-world-app/server.py`) FROM THE PACKED TREE, and a
real computer-use actor uses it. No `this-repo` special-casing involved:
the generic local-tree route covers the self-hosting case.

## Result (kept run id: `cua-2026-07-08T19-55-34-675Z-472a0e21`)

- Packed 264 entries, 3,664,609 bytes from the repo working copy.
- Provenance: `archiveSha256 c3ca216f28476d12e0878446038412466b1974498c8b03ee68a9714e28c58898`,
  `commit 42ff8a118b3e2fd9ba0fa5fbea6b9c58248e7e05` (the local-tree merge
  commit itself), `dirty: false`.
- Actor: `openai-computer-use`, completed `goal_satisfied` ("Done") after
  adding one task through the fixture app's real UI.
- `homun verify`: ok, 15/15 checks, `shareSafety.status: local_only`.
- Sandbox reclaimed by id.
- The one-line pack summary printed before any sandbox call:
  `homun local-tree: packed 264 entries, 3664609 bytes, archiveSha256 c3ca21... (commit 42ff8a118b3e, clean working tree)`.

## Same-day real-app validation (private receipt)

The same machinery was validated the same day against a maintainer's
private production Next.js app, packed from its working copy and booted on
the STOCK sandbox image (node bootstrap + package-manager install + full
build + serve), with a deterministic `stopWhen` terminal ending the
computer-use session `goal_satisfied`. That receipt contains private names
and is retained outside this repository. Two operational lessons from it
are public-safe and recorded here:

- A `stopWhen` rule is load-bearing for look-at-things missions: without a
  deterministic terminal, a computer-use actor can keep exploring until the
  wall clock ends the session.
- Apps whose native dependencies build via install scripts need
  `subject.serve.install` WITHOUT `--ignore-scripts` (the sandbox is the
  trust boundary; pnpm 10's `onlyBuiltDependencies` allowlist still
  applies).
