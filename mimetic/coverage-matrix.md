# Coverage Matrix

| Area | Persona | Happy Path | Sad Path | Status |
| --- | --- | --- | --- | --- |
| Command discovery | synthetic-new-user | help lists command ladder | missing/unclear command is visible in review | covered by dry-run contract |
| Setup readiness | synthetic-new-user | doctor passes after committed dogfood config | doctor fails before config or missing ignore rules | covered by dogfood config |
| Run bundle | synthetic-new-user | watch creates a fresh 4-sim dry-run from `mimetic/` persona/scenario sources; `codex-exec` creates 1-4 lane live actor bundles | unsupported live runs still fail closed; Codex TUI blocks before spawn when workspace trust is missing | covered by watch and exec fanout contracts |
| Observer | skeptical-power-user | observer renders completed dry-run, completed `codex-exec` fanout, blocked Codex TUI bundles, and active `codex-exec` running snapshots | Codex TUI live streaming while the TUI actor is running is deferred | partial |
| Feedback issue | skeptical-power-user | issue draft is public-safe and mutation-free | any redaction ambiguity blocks issue drafting | covered by feedback contract |
| Release gate | skeptical-power-user | pack dry-run is inspectable | publish remains blocked without maintainer approval | covered by release readiness |
