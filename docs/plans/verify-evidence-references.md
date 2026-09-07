# Verify declared actor and feedback evidence

Ordinary `verify` currently checks stream and adapter artifacts but can accept
an actor frame whose `screenshotRef.path` is missing or unsafe, or a feedback
candidate whose supporting file does not exist. This leaves a verified run with
broken evidence and postpones the failure until a downstream consumer.

## Contract

- Include screenshot references declared by `stream.actor.items` and
  `stream.liveActor.items` in the existing local-evidence check. Absent references
  are allowed; malformed present references fail without throwing.
- Actor screenshot paths are relative to the run root. Reject remote schemes,
  absolute paths, traversal and unsafe names. Do not apply the UI/embed legacy
  parent-directory normalization to actor paths.
- Read each declared screenshot through the existing contained-file API and
  image validator. Preserve its current decoded-PNG contract and size limits.
  Valid raw screenshots remain verifiable with `local_only` sharing posture.
- Include every feedback candidate's evidence. Screenshot evidence requires a
  valid nonempty image. Other candidate evidence requires an existing regular
  file, including a zero-byte file accepted by the feedback consumer.
- Merge file requirements conjunctively: a candidate that accepts an empty file
  cannot weaken another consumer's nonempty requirement. Preserve the qualified
  zero-event terminal-trace exception and the startup-failure evidence matrix.
- An explicit `screenshotRef.redaction: none` on any final or partial live actor
  item contributes to the existing `RAW_SCREENSHOTS` sharing reason. The run is
  valid local evidence, with `local_only` posture. A top-level actor declaration
  of raw screenshots remains authoritative even if a frame says blurred; a raw
  frame also wins over a top-level blurred declaration.
- Preserve the existing permissive shape handling of absent or unknown per-frame
  redaction metadata. This amendment recognizes explicit raw declarations; it
  does not infer privacy from pixels or certify missing metadata. Path validity
  remains independently enforced for every present screenshot reference.

## Proof

Tests cover actor and liveActor references that are valid, absent, malformed,
missing, remote, traversing or corrupt; candidate-only log and screenshot
references; and a candidate pointing at a valid empty terminal-events file with
stricter shared consumers. Run focused tests and `pnpm release:check`.
Sharing tests cover official partial live traces with raw frames, contradictory
top-level/frame declarations, blurred and OCR-scrubbed positive declarations,
and missing per-frame metadata compatibility.

This change checks declared evidence. It does not scan every unreferenced leaf,
change capture redaction, or adopt bundle-export omission and privacy policies.
