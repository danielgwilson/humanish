# Mimetic Dogfood Config

This directory is the committed source plane for dogfooding `mimetic-cli` with
Mimetic itself.

Current scope:

- public-safe synthetic CLI personas;
- one-command `watch` contract proof over the package, command tree, observer,
  and feedback issue path;
- one explicit 1x `codex-exec` local actor proof path;
- one explicit 1x Codex TUI actor path with fail-fast workspace-trust
  preflight;
- no 4x live actor fanout yet;
- no E2B, GitHub mutation, production data, or private artifacts in local
  dogfood runs.

Generated run bundles, observer HTML, review packets, logs, and local overrides
belong in ignored `.mimetic/`.

When Codex TUI trust bootstrap and fanout exist, this config should become the
first 4x persona harness target.
