# Retained analysis challenges

These four neutral cases test interpretation of repeated uncertainty, recovery,
competing blockers, sparse fixtures, misread labels, and unsupported completion
accounts. They are **scripted reconstructions**, not live autonomous participant
studies or reproductions of a private recording. The accounts and stage transitions
are authored; the PNGs and reported local browser URLs are actually captured.
The bundle's `live` mode admits the production analysis service and does not
override its explicit reconstruction provenance.

`cases.mjs` is the source fixture and prospective gold. Generated bundles, PNGs,
wire bodies, model outputs, and accounting must remain outside the repository.
No provider response is fabricated. The runner uses an installed package's real
capture, admission, provider, validation, receipt, storage, and Observer paths.

```bash
node scripts/analysis-quality-eval.mjs author --out <external-evaluation-directory> --package <installed-humanish-directory>
node scripts/analysis-quality-eval.mjs prepare --tag baseline --out <external-evaluation-directory> --package <installed-humanish-directory>
# Paid: requires OPENAI_API_KEY in the environment and explicit spending authority.
node scripts/analysis-quality-eval.mjs run --tag baseline --execute --out <external-evaluation-directory> --package <installed-humanish-directory>
```

Authoring needs the `agent-browser` CLI and a local browser. It serves only a
temporary loopback fixture, closes its dedicated browser session, and freezes
source/gold/capture hashes before analysis. Preparation copies identical source
bytes and pins the installed package's relevant compiled modules, selected packet,
configuration, and admission. Use a different tag and installed package for the
candidate; do not regenerate the corpus between versions.

Each request reserves $3 against a $25 evaluation allowance. Four baseline and
four candidate calls reserve $24. This is a conservative local reservation, not a
provider-enforced billing cap. All attempts remain in the ledger, including
unknown usage and failures. Consumed attempts never silently retry. Neither
authoring nor preparation calls the model. The runner stores exact request and
response bodies without authorization headers; keep its output directory private.

Freeze judgments before viewing model output. Judge the complete first response,
including rejected output and every factual field, against the original source
and separately against the selected packet:

1. Split compound factual claims into atomic assertions. Record support, basis,
   references, material qualifications, and each contradicted/unsupported claim.
2. Match required concerns semantically. Count all three consequential concerns,
   preserve exact affected/exposed membership, and distinguish resolved selection
   from the unresolved submission blocker. The blocker must rank first.
3. Check each negative control and every outcome. A reported success is not a
   verified submission; a visible label outranks an authored misreading. Expected
   fixture sparsity does not establish a defect.
4. A candidate's concern-review exclusions must be evidence-linked and justified.
   A required concern dismissed as context is still a recall miss. An invented
   problem is not excused by a correct exclusion elsewhere.
5. Report integer supported/total factual claims, required recall, count and rank
   agreement, exact quotes, unsupported high-confidence claims, and critical or
   material errors individually. Never average a consequential error away.

The scoped acceptance target is no unresolved critical/material factual errors,
three of three consequential concerns recalled, correct recovery and participant
sets, the required rank pair satisfied, and no invented negative-control defect.
An operational/validation failure is a failed attempt, not a clean negative.
Record any post-output ambiguity adjudication separately without rewriting the
prospective gold. These deliberately designed regressions support only bounded
behavior claims; they do not estimate population recall or independent-study
quality, and they do not replace fresh live studies.
