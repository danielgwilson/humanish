# Goal: `subject.source: local-tree`

Status: shipped (slice 1 merged in PR #265; live receipts below; follow-ups in #266)
Issue: [#261](https://github.com/danielgwilson/homun/issues/261)

## Why

Homun can boot a subject app today only by cloning a public remote repo
(`subject.source: clone`) or by pointing at an app the operator already
started (`app-url` / `local-app`). `this-repo` is dry-run only. There is no
path from a local working copy into the sandbox.

That blocks the primary UX this tool exists for: run `npx homun` from your
project directory and have the harness pack, upload, boot, and drive **your
working tree**, including uncommitted changes and apps whose repos are
private. The tree you are iterating on is exactly the tree you want personas
to hit; a remote clone is always one commit behind your working state.

## Not a new trust surface

`subject.serve.start` and `subject.state.seed[].command` are already
arbitrary author-trusted shell executed inside the sandbox. The sandbox is
the trust boundary. `local-tree` adds no host-side code loading and no new
privilege; it changes only where the subject bytes come from.

The real design decision is **packaging and redaction**: a dirty working
tree can contain secrets. That is what this document specifies.

## Config surface

```yaml
schema: homun.lab.v2
id: my-app-local
subject:
  source: local-tree
  serve:
    install: pnpm install --frozen-lockfile --ignore-scripts
    build: pnpm build
    start: pnpm start
    url: http://127.0.0.1:3000
  env: [MY_APP_FLAG]
  localTree:
    exclude:
      - "big-media"
    keep: false
execution:
  target: e2b-desktop
actors:
  - type: openai-computer-use
```

- The packed root is the lab resolution cwd (the project directory homun
  runs from). No path field exists, by design: an absolute path in a lab
  manifest would be a machine-specific, unshareable, leak-prone artifact.
- `subject.serve` is required and identical in shape and semantics to the
  clone route (install/build/start/url/timeouts, loopback-only url).
- `subject.env` and `subject.state` (seed steps, external env, checkpoints)
  are reused unchanged.
- `subject.localTree` is optional:
  - `exclude`: extra archive excludes on top of the always-on denylist.
    Entries match as a repo-relative path prefix or an exact basename.
    Absolute paths and glob syntax are REJECTED at parse time (a mis-shaped
    exclude the author believed in must never silently no-op); leading
    `./` and trailing `/` are normalized.
  - `keep`: keep the sandbox on failure for debugging (mirrors
    `subject.clone.keep`). Unlike a kept clone sandbox, whose contents are
    a repo the operator could already clone, a kept local-tree sandbox
    holds the packed working tree, including any file that survived the
    denylist.
  - `maxArchiveBytes`: upload size cap override. Default 256 MiB.
- Routing requires `execution.target: e2b-desktop` and a computer-use
  actor. Everything else fails closed at parse time with a precise reason.

## Packing design

Enumeration produces ONE file list that drives BOTH the tar archive and the
content digest, so the two cannot apply different exclusion rules (a
two-implementations drift class we observed in a prior in-house harness and
deliberately design out here).

1. **Git-aware enumeration (preferred).** When the root is a git work tree,
   the list is `git ls-files --cached --others --exclude-standard -z`:
   tracked files plus untracked-but-not-ignored files. This is the honest
   definition of "the working tree you are iterating on": it respects
   `.gitignore` exactly as git does, and it includes uncommitted work.
   Entries that no longer exist on disk (staged deletes) are dropped.
2. **Fallback enumeration.** When the root is not a git work tree, a
   recursive walk applies only the denylist. `.gitignore` semantics require
   git; the fallback is documented as coarser.
3. **Always-on denylist (fail closed, applied in both modes, not
   overridable).** Path segments: `.git`, `node_modules`, `.homun`. Basename
   patterns: `.env*` (all of them, including `.env.example`; boot env comes
   from `subject.env`, never from packed files), key material (`*.pem`,
   `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.ppk`, `*.gpg`,
   `id_rsa*`, `id_dsa*`, `id_ed25519*`, `id_ecdsa*`), and common
   credential-shaped names (`.npmrc`, `.netrc`, `.dockercfg`, `kubeconfig`,
   `credentials.json`, `service-account.json` and its camel/snake variants,
   `secrets.json`/`.yaml`/`.yml`, `auth.json`, `*.tfstate`,
   `terraform.tfstate.backup`). The full authoritative list is
   `LOCAL_TREE_DENYLIST_BASENAME_PATTERNS` in `src/source-archive.ts`.

   **Honest boundary:** the denylist matches names, not contents. A secret in
   a file the list does not name WILL pack if it is tracked or
   untracked-but-not-ignored, and `.gitignore` does nothing for files that
   are already tracked. The operator's controls are `localTree.exclude`, the
   one-line pack summary printed to stderr on every live pack (entry count,
   byte count, digest, dirty state), and reviewing the tree before running.
   Content-based secret scanning is a possible future hardening, not a
   current promise.
4. **Only regular files and symlinks are packed.** Symlinks are stored as
   symlinks, never dereferenced: a link pointing at a secrets file outside
   the tree contributes only its target path string, never target bytes.
   Directory entries are never recursed from the list (this also naturally
   excludes nested git worktrees and submodule contents, which enumerate as
   directory-shaped entries, not files).
5. **Determinism.** The list is sorted bytewise. The digest is
   `archiveSha256`: sha256 over the sorted record sequence, where a file
   contributes `file\0<relPath>\0<size>\0` followed by its bytes and a
   closing `\0`, and a symlink contributes `symlink\0<relPath>\0<target>\0`
   (target string, never target bytes). Full 64-hex is persisted: this value
   is the provenance pin, not a display digest, so it does not use the
   repo's 16-char display-digest convention. The digest and the tar file
   list derive from the same single enumeration, so they cannot drift from
   each other; a tree mutated concurrently DURING packing is not defended
   (the pin describes the tree as read, and the live receipt demonstrates
   the digest changing when the tree changes).
6. **Size cap.** Enumeration fails closed when total bytes exceed
   `maxArchiveBytes` (default 256 MiB), naming the size and the knob. The
   whole archive is buffered for one `files.write` upload, so the cap also
   bounds host memory.
7. **Tar invocation.** System `tar -czf <out> -C <root> --null -T
   <listfile>` (the `-C` must precede `-T`: both are position-sensitive in
   GNU tar, and list names resolve against the directory in effect at that
   point), with darwin metadata suppression flags (`--disable-copyfile
   --no-xattrs --no-mac-metadata`) when packing on macOS. The archive bytes
   themselves are not required to be byte-reproducible; identity is the
   file-list digest, not the tar bytes.

## Transfer and provisioning

- Pack **once per run** on the host, into an ignored temp location; every
  fan-out lane uploads that one archive, and every lane's provenance records
  the same `archiveSha256` because there is only one archive to record.
- Upload via the sandbox `files.write(remotePath, arrayBuffer,
  { useOctetStream: true })` seam.
- Extract via one command: `rm -rf <SUBJECT_DIR> && mkdir -p <SUBJECT_DIR>
  && tar -xzf <remote> -C <SUBJECT_DIR> && rm -f <remote>`, executed as a
  bounded detached step (`runDetachedStep`, step name `subject-extract`,
  same machinery as the clone/install/build steps) so a failure surfaces a
  scrubbed log tail. The real SDK THROWS `CommandExitError` on any non-zero
  exit; the upload and extract paths are modeled on that contract, and the
  deterministic tests cover both the throwing shape and the structural
  returning fake shape.
- After extraction, the existing subject pipeline runs unchanged: optional
  install, seed steps (`before-build`), optional build, seed steps
  (`before-start`), detached `serve.start`, readiness probe on `serve.url`,
  seed steps (`after-ready`).
- The in-sandbox commit refresh is skipped: `.git` is never uploaded, so
  subject identity comes from host-side capture at pack time.

## Provenance

`RunSubjectProvenance` gains a third source:

```
subject: {
  source: "local-tree",
  archiveSha256: <64 hex>,       // the pin; a dirty tree cannot be commit-pinned
  commit?: <full git sha>,       // host-side HEAD when the root is a git work tree
  dirty?: boolean,               // host-side porcelain status when git is present
  envNames?: [...],              // declared env NAMES only, as today
  state: { ... }                 // unchanged seeded/unpinned/declared-not-run/undeclared block
}
```

- No path, basename, branch name, or file name from the host machine ever
  enters the bundle. Identity is digests, a sha, a boolean, and counts.
  This mirrors the two existing guardrails: the `[target-cwd]` sentinel and
  the closed `SAFE_GIT_NOTES` enum for the harness's own git state.
- `homun verify` extends the fail-closed provenance guard: a `local-tree`
  subject must carry a well-formed `archiveSha256`; a malformed value fails
  verification without echoing the value into the finding.
- The bundle schema change is additive under `homun.run-bundle.v1`, and
  `docs/contracts/schemas.md` is updated in the same change.

## Failure modes (all fail closed)

- Root is neither a git work tree nor a readable directory: parse/preflight
  error naming the resolved requirement, never a silent fallback.
- Archive exceeds the size cap: error names total bytes and the knob.
- Upload or extract fails: lane fails with the scrubbed command failure
  tail; `subject.localTree.keep: true` preserves the sandbox for debugging.
- Readiness probe timeout: unchanged behavior from the clone route
  (detached start log tail is surfaced).

## Out of scope (follow-up slices)

- `topology: shared-world` with a local-tree subject. The validation gate
  stays clone-only until the shared-world engines grow local-tree
  provisioning and provenance in a dedicated change.
- Live `this-repo` routing (self-dogfood) via the same packing machinery.
- Snapshot / prepared-runtime caching of an installed subject.
- Multi-origin serve.
- `.gitignore` semantics without git installed.
- `homun lab preflight` reachability probes (`sandbox-loopback`) for
  local-tree labs; the route error names this gap and a dry run is the
  current no-spend check.
- Content-based secret scanning of the packed tree (the denylist is
  name-based; see the honest boundary note above).

## Proof

- `pnpm check` and `pnpm public-surface:scan`.
- Deterministic contract tests:
  - enumeration honors `.gitignore` (git fixture), the always-on denylist
    (planted `.env`, `*.pem`), and `localTree.exclude`;
  - a planted nested repo directory and a symlink are handled per spec;
  - digest is stable across an untouched tree and changes when a file
    changes; dirty flag truthful against a git fixture;
  - upload/extract handles the throwing `CommandExitError` shape AND the
    structural returning fake shape;
  - lab-config accepts the minimal local-tree lab and rejects each
    mis-config with a precise reason;
  - run-bundle guard accepts the new provenance and verify fails closed on
    a malformed `archiveSha256`.
- One live rung with a kept receipt under `receipts/`: a lab packs a
  synthetic fixture app from a working copy with an uncommitted change,
  boots it in a hosted desktop, a computer-use actor drives it, and
  `homun verify` passes with `archiveSha256` present and `dirty: true`.
  DONE: `receipts/local-tree-live-2026-07-08.md`.
- Self-dogfood rung: this repository packs its own working copy and a
  computer-use actor drives the committed fixture app served from the
  packed tree. DONE: `receipts/self-dogfood-live-2026-07-08.md`, which
  also records the public-safe lessons from a same-day private real-app
  validation.
