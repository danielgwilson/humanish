# Redacted bundle export

Status: implementation specification, 2026-09-07. Tracks #136.

A completed study normally keeps readable screenshots in local `.humanish/` storage.
Its `local_only` sharing grade prevents public feedback generation. Today the operator
must repeat a paid study with irreversible capture-time blur to obtain a shareable
bundle. Export should transform a copy of the existing evidence instead.

## User contract

```bash
humanish export --run RUN --format bundle --redact-screenshots --out ./shared-study
humanish verify --cwd ./shared-study --run RUN --json
humanish observe --cwd ./shared-study --run RUN --open
humanish feedback draft --cwd ./shared-study --run RUN
humanish feedback issue --cwd ./shared-study --run RUN --repo owner/repo
```

The output is a new standalone workspace containing `.humanish/runs/RUN/`. It is
separate from the source run history: a derivative is not another participant or
paid attempt. The default remains the existing single-file HTML export. Bundle
format requires explicit screenshot redaction, refuses `--local-only`, and never
overwrites a destination. Its default destination is
`.humanish/exports/RUN-redacted/`. `--max-bytes` bounds source inventory and output.

The original run must verify successfully and be complete. `local_only` is accepted
only for raw screenshots; an invalid or otherwise blocked run is refused. No
provider or network calls are made. The source run, latest pointer and status remain
unchanged. The exported folder works after the source folder is unavailable.

## Evidence transformation

1. Bind the physical source run, enumerate every directory and regular file without
   following aliases, and read every leaf through contained file readers. Refuse
   symlinks, hardlinks, special files, unreadable leaves, escaping references and
   unbounded file counts or bytes. Retain a sorted source digest inventory. Verify
   a private snapshot of those exact bytes in mode-0700 OS temporary storage,
   independent of the chosen output filesystem; never re-read mutable source
   facts as the basis of a transformation. Remove that raw snapshot before publishing.
2. Support PNG screenshot leaves using the existing bounded blur primitive. Require
   successful PNG decoding; malformed or unsupported images fail rather than become
   placeholders. Transform all PNG leaves, including unreferenced duplicates. Other
   image encodings, SVG, archives and unknown binary formats fail explicitly.
3. Accept a documented small UTF-8 text set (`json`, `ndjson`, `jsonl`, `md`, `txt`,
   `log`, `yaml`, `yml`, `csv`). Reject invalid UTF-8, binary control bytes, inline
   raster data and encoded raster signatures, including JSON-escaped strings.
   Existing secret/path scans must pass both before and after transformation.
   This does not certify the absence of personal information in natural text.
4. Preserve run ID, measured timestamps, subject/source pins, actor settings and
   actions, tasks, outcomes, cost/unknowns, candidates and attribution limits.
   Update screenshot declarations in embedded and standalone actor traces to
   describe export-time blur accurately. Preserve screenshot paths so evidence
   references keep resolving. Do not claim original capture was blurred.
5. Discard cached Observer HTML/data and previously generated feedback files, then
   regenerate Observer from transformed canonical evidence. Refuse any other HTML
   rather than copying executable or inline-image payloads. Omit local process
   `status.json` and the operational `sandbox-receipts.ndjson` journal; inventory
   their hashes with explicit omission reasons. A derivative cannot become a new
   resource lease. Any evidence reference that requires an omitted file fails.
6. Write `derivation.json` in the derivative run: schema/version, source run ID,
   export timestamp, source inventory digest and per-file source/output digests,
   transformation or omission, and hashes for regenerated projections. It records transformation provenance, not a rerun
   or independent evidence of the source's truth.
7. Build in a private sibling staging workspace. Reverify the complete result with
   normal verification and require `share_ready`; recheck the source identity and
   inventory for concurrent mutation. Claim the new output directory exclusively
   only after validation, then publish its complete `.humanish` tree by rename.
   An existing output is never replaced. Failure removes only owned staging/output
   state and returns a structured error without a completed artifact.

Public images remain coarse thumbnails. This feature preserves readable local
evidence while enabling the current public-safe feedback path; it does not produce
readable redacted screenshots or replace a maintainer's review before sharing.

## Acceptance proof

- A real raw CUA bundle remains byte-identical and `local_only`; its derivative
  verifies `share_ready`, opens in Observer, supports feedback draft/verify/issue,
  and exports HTML through existing commands after the source is unavailable.
- Transformed image bytes have bounded dimensions and differ from the originals;
  no raw image, stale Observer payload, inline raster or unsupported archive leaks.
- Source/candidate identities and measured outcomes/tasks/cost/provenance match.
- Tests reject missing/corrupt images, unknown binaries, data URIs including JSON
  escapes, malformed text, secret-shaped text, traversal/symlinks/hardlinks, existing
  output, source mutation and interrupted publication. Tests inspect actual emitted
  artifacts and use the real verifier, not only a declared sharing flag.
- CLI flag combinations fail before output. Existing HTML behavior remains covered.
- New real N>1 live raw studies exercise exact-candidate downstream commands;
  deterministic fixtures and replayed older bundles are labelled separately.
