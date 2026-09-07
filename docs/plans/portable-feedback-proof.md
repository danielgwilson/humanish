# Portable feedback acceptance commands

Feedback currently emits `pnpm humanish -- verify/watch ...`. An exported evidence
workspace contains `.humanish/`, without a package manifest or repository script,
so these commands fail before the installed CLI runs.

## Change

- Generate `humanish verify --run RUN --json` and
  `humanish watch --run RUN --no-open` from one helper. Quote unusual run IDs for
  shell use. Commands run from the workspace containing the evidence, with the
  Humanish CLI available on `PATH`; they do not implicitly install a package.
- Apply the helper to CUA participant candidates, OSS meta-lab candidates, and
  live/dry-run fallback feedback drafts.
- When redrafting a retained candidate, translate only an exact legacy command
  for that same run and only when the candidate matches the existing first-party
  ID, actor, stream and idempotency conventions. Keep unrelated/custom commands,
  prose, additional flags and commands for another run byte-for-byte.
- Change only the feedback projection. Do not rewrite source candidates,
  `run.json`, screenshots, receipts or derivation inventories. Existing stored
  drafts remain readable as stored; `feedback draft`, `verify` and `issue`
  regenerate them from the source bundle.

Legacy identity recognition is a compatibility rule, not provenance attestation.
Unrecognized custom candidates remain unchanged. No schema version changes or
provider calls are required. Ship this focused fix as Humanish 0.84.1.

## Proof

Execute generated verification commands in a fresh workspace containing only
retained evidence, without `package.json` or `node_modules`, through the installed
CLI. Exercise the generated watch command and confirm its Observer starts, then
close it. Confirm source hashes do not change when feedback is redrafted.

Tests cover all first-party generators, legacy recognized candidates, custom and
near-match instructions, run-ID shell quoting, and fallback drafts. Required
release, docs, site and independent review gates apply before publication.
