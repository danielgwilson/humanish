# 0002: The Observer is one self-contained HTML file

Accepted.

## Context

Run bundles are archived, exported and shared, and people open them later, offline or from a
static host. A viewer that needs a running server, a CDN or a network call stops working in
exactly those cases.

## Decision

The `observer/` workspace builds with Vite into a single HTML file with fonts inlined and no
network references. The root build copies it to `dist/observer-app.html`. `renderObserverHtml`
is the one path every surface (observe, watch, serve, labs) uses; it injects the run's
`humanish.observer-data.v1` snapshot into that file. There is no second renderer and no feature
flag; rolling back means pinning an older package version.

## Consequences

- An Observer page opens from disk, and an exported bundle carries its own viewer.
- Every dependency the Observer adds ships inside each rendered page, so page weight is a cost
  reviewers check.
- Live views (`watch`, `serve`) use the same file and poll for new snapshots.

## Enforced by

- The observer workspace tests (single file, inlined fonts, no network references).
- `tests/observer/artifact.test.ts` for the artifact path and the cold auto-build.
- `tests/observer/data-contract.test.ts` for the data schema.
