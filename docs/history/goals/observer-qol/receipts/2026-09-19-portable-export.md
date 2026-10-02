# Large portable recording export — 2026-09-19

A retained twelve-participant recording with 344 captures produced a
323,755,072-byte HTML export. Repeated screenshot references carried repeated
base64 payloads, and concurrent traversal could read and count the same path
more than once.

The candidate stores each unique raster once, addressed by its SHA-256. Run-data
strings refer to these renderer-owned assets; the evidence schema, frame IDs and
timestamps are unchanged. Separate inert raster elements avoid parsing a giant
image table as JSON. The viewer converts a registered raster to a document-owned
Blob URL once and releases its base64 DOM text. Arbitrary Blob URLs, SVG, HTML,
remote URLs and missing asset references remain rejected by screenshot rendering.
Legacy raster data URIs and ordinary served recording paths still work.

The export measured 150,051,803 bytes (about 143 MiB), with 335 unique raster
payloads. All 344 capture references matched the original file bytes and event
identities. No image was resized, recompressed or cropped. The existing sharing
gate and local-only watermark were retained.

The actual large file was opened from `file://` with network requests blocked.
Both 1440×1000 desktop and 390×844 phone checks passed:

- Twelve participants render; first usable grid in 2.9 / 2.8 seconds.
- A screenshot completes in 3.1 / 2.9 seconds from navigation.
- Seeking and verifying all twelve selected image hashes takes 0.85 / 0.82 seconds.
- Play/pause, grid-to-participant navigation, backward seeking and return to the
  grid preserve the global recording position.
- Findings expand and their evidence links open the recorded participant moment.
- No page errors, external requests, runtime iframes or horizontal overflow.

These are one-machine observations, not a performance guarantee. The file remains
large because it retains exact raster evidence. Missing source images retain an
explicit export warning; deduplication cannot reconstruct missing evidence. A
single image above 64 MiB is refused rather than emitted as an unsupported asset.

Focused checks: `tests/export.test.ts`, `tests/export-bundle.test.ts`,
`observer/tests/export-assets.test.ts`, and the existing artifact-href tests.
The raw study, browser screenshots and machine-readable proof remain in private
operator storage. Public tests use synthetic imagery only.
