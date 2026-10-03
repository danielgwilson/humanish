# Contracts

Each page describes a shape that code outside humanish can depend on. A documented field is API;
the types, parsers and validators in `src/` are the source of truth when a page and the code
disagree.

- [schemas.md](schemas.md): every `humanish.*` schema id, the study manifest, the library options
  (`RunStudyOptions`) and the exports removed in 0.107.0.
- [core.md](core.md): the records a run writes under `.humanish/runs/<id>/` and how each route
  starts a run.
- [run-bundle.md](run-bundle.md): `humanish.run-bundle.v1`, the evidence contract that `verify`
  checks.
- [policy.md](policy.md): credential, network, spend, redaction, sharing and assisted-run
  boundaries.
- [feedback.md](feedback.md): feedback candidates, drafts and issue URLs, which never mutate
  GitHub.
- [study-analysis.md](study-analysis.md): post-run analysis of retained participant evidence.
- [study-costs.md](study-costs.md): what `humanish stats` counts as spend.
- [errors.md](errors.md): the error code families, where each code appears, and the human
  error shape on stderr.
- [adapter-admission.md](adapter-admission.md): the admission limit a custom provider can raise
  before a request is sent.
- [adapter-fixtures.md](adapter-fixtures.md): the committed adapter fixtures and the parity checks
  over them.
