# Coverage Matrix

| Area | Persona | Happy Path | Sad Path | Status |
| --- | --- | --- | --- | --- |
| Command discovery | synthetic-new-user | help lists command ladder | missing/unclear command is visible in review | covered by dry-run contract |
| Setup readiness | synthetic-new-user | doctor passes after committed dogfood config | doctor fails before config or missing ignore rules | covered by dogfood config |
| Run bundle | synthetic-new-user | dry-run uses `mimetic/` persona/scenario sources | live run fails closed until actor support exists | covered by dry-run contract |
| Observer | skeptical-power-user | static observer renders latest bundle | live observer and browser auto-open are deferred explicitly | partial |
| Feedback issue | skeptical-power-user | issue draft is public-safe and mutation-free | any redaction ambiguity blocks issue drafting | covered by feedback contract |
| Release gate | skeptical-power-user | pack dry-run is inspectable | publish remains blocked on Daniel approval | covered by release readiness |
