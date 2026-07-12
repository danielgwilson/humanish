# Humanish Dogfood Config

This directory is the committed source plane for dogfooding `humanish` with
Humanish itself.

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
belong in ignored `.humanish/`.

Format standard:

- human-authored Humanish source uses `.yaml`;
- executable integration uses `.ts`;
- generated artifacts, synthetic fixtures, and event streams use `.json` or
  `.ndjson`;
- `.yml` is reserved for outside ecosystem files such as GitHub Actions, not
  Humanish source.

Executable browser journeys live in `humanish/scenarios/*.yaml` under
`browser.steps`. `humanish run --app-url <loopback-url>` uses those steps when
present and falls back to the built-in two-step browser persona proof when no
executable browser scenario exists.

This config is the first full local TUI harness target; future slices can decide
whether TUI-specific fanout is needed beyond the current `codex-exec` fanout.
