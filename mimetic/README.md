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
- active-run Observer data refresh while the 1x Codex TUI actor is running;
- no E2B, GitHub mutation, production data, or private artifacts in local
  dogfood runs.

Generated run bundles, observer HTML, review packets, logs, and local overrides
belong in ignored `.mimetic/`.

This config is the first full local TUI harness target; future slices can decide
whether TUI-specific fanout is needed beyond the current `codex-exec` fanout.
