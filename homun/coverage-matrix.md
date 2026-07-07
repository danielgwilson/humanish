# Coverage Matrix

| Area | Persona | Happy Path | Sad Path | Status |
| --- | --- | --- | --- | --- |
| Command discovery | synthetic-new-user | help lists command ladder | missing/unclear command is visible in review | covered by dry-run contract |
| Setup readiness | synthetic-new-user | doctor passes after committed dogfood config | doctor fails before config or missing ignore rules | covered by dogfood config |
| Run bundle | synthetic-new-user | watch creates a fresh 4-sim dry-run from `homun/` persona/scenario sources; `codex-exec` creates 1-4 lane live actor bundles; exact-trusted Codex TUI can complete with a sanitized verdict marker | unsupported live runs still fail closed; Codex TUI blocks before spawn when exact workspace trust is missing | covered by watch and local actor contracts |
| Observer | skeptical-power-user | observer renders completed dry-run, completed `codex-exec` fanout, completed or blocked Codex TUI bundles, active `codex-exec` running snapshots, and active 1x Codex TUI running snapshots | TUI-specific fanout beyond 1x TUI remains deferred | covered for current local actor split |
| Feedback issue | skeptical-power-user | issue draft is public-safe and mutation-free | any redaction ambiguity blocks issue drafting | covered by feedback contract |
| Release gate | skeptical-power-user | pack dry-run is inspectable | publish remains blocked without maintainer approval | covered by release readiness |
