# Mimetic Dogfood Config

This directory is the committed source plane for dogfooding `mimetic-cli` with
Mimetic itself.

Current scope:

- public-safe synthetic CLI personas;
- one-command `watch` contract proof over the package, command tree, observer,
  and feedback issue path;
- one explicit 1-4 lane `codex-exec` local actor fanout proof path;
- active-run Observer data refresh while `codex-exec` actor lanes are running;
- one explicit 1x Codex TUI actor path with exact workspace-trust preflight,
  terminal startup responses, and sanitized verdict-marker classification;
- no live Codex TUI Observer follow while the TUI actor is still running yet;
- no E2B, GitHub mutation, production data, or private artifacts in local
  dogfood runs.

Generated run bundles, observer HTML, review packets, logs, and local overrides
belong in ignored `.mimetic/`.

When Codex TUI live follow exists, this config should become the first full
local TUI harness target.
