# Adapter Fixture Parity Contract

Date: 2026-06-02 (current-state note updated 2026-07-14)

Status: committed contract fixtures with passing parity checks. A fixture
proves that core can carry an adapter-owned evidence shape; it does not prove a
live adopter integration or satisfy a deletion-branch depth phase.

## Purpose

Adapter fixtures prove that Humanish can carry target-specific evidence without
moving target truth into core schemas. A fixture is not a product claim. It is a
public-safe contract packet that shows the routes, personas, milestones,
terminal evidence, feedback drafts, and policy decisions a real adapter must
emit before live behavior can be trusted.

The fixture contract keeps three boundaries explicit:

- Core owns run-bundle identity, artifact layout, verification, review,
  redaction, and feedback mechanics.
- Adapters own target routes, scenario language, personas, milestone names,
  command surfaces, and acceptance proof.
- Public issue drafts use redacted artifact pointers only; they do not require
  GitHub tokens, hosted product memory, private transcripts, or live mutation.

## Fixture Set

The committed fixture set lives under `adapters/fixtures/`.

| Fixture | Proves | Required artifacts |
| --- | --- | --- |
| `post-auth-return-dry-run` | A web-app adapter can keep upload, studio, and auth-return milestones adapter-owned while emitting a product-neutral dry-run bundle. | `adapter.json`, `persona.json`, `scenario.json`, `milestones.json`, `run-bundle.json` |
| `terminal-feedback-lifecycle` | A terminal-first adapter can emit sanitized transcript evidence, issue-draft material, cost/redaction policy, verification checks, and feedback lifecycle proof without browser-only assumptions. | `adapter.json`, `policy.json`, `run-bundle.json`, `feedback-draft.json`, `verify-result.json`, `transcripts/sanitized-terminal.txt` |

## Promotion Gates

A fixture can be promoted only when:

- every example is synthetic or redacted;
- artifact paths are relative and do not contain traversal segments, absolute
  local paths, hosted stream URLs, or auth-bearing links;
- credential policy records env var names only, never values;
- adapter-owned nouns do not appear in core schema docs or core runtime code;
- public feedback material states that GitHub mutation was not performed;
- the fixture can be checked with `pnpm test tests/adapter-fixtures.test.ts`
  and `pnpm public-surface:scan`.

## Dry-Run Web-App Fixture Shape

The web-app fixture models a local app with three adapter-owned route groups:

- `upload`: synthetic file input and validation state;
- `studio`: synthetic work surface and result-review state;
- `auth-return`: a post-authentication return path using a synthetic state id.

The dry-run bundle does not add route or milestone fields to core. Instead, it
references adapter-owned routes through `streams[].ui.route`, milestone events
through lifecycle/event records, and the milestone manifest through relative
artifact pointers.

## Terminal Feedback Fixture Shape

The terminal fixture models a command-driven product surface. Its bundle uses a
`terminal` evidence stream, a sanitized transcript pointer, a feedback
candidate, a separate feedback draft artifact, and a verification result that
checks required public-safe files without reading or requiring raw private
transcripts. Policy is adapter-owned and records:

- `spend_policy: no_spend`;
- `network_policy: no_network`;
- `github.mutation: not_requested`;
- `hosted_product_memory.required: false`;
- redaction status and denied material classes.

This keeps terminal and feedback parity independent from browser screenshots.

## Proof Commands

```bash
pnpm test tests/adapter-fixtures.test.ts
pnpm public-surface:scan
```
