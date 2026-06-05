# Receipts: Private Repo Agent Dogfood Study

Receipts in this directory must be public-safe.

Allowed:

- redacted lane labels such as `repo-01` through `repo-04`;
- run IDs and local artifact paths;
- pass/fail/block classifications;
- setup-quality summaries;
- meaningful-use ratings;
- public-safe issue URLs in `mimetic-cli`;
- provider cleanup/readback summaries.

Forbidden:

- private repo owner/name labels;
- private source snippets;
- private screenshots;
- raw private terminal transcripts;
- secret values, token fragments, stream auth URLs, provider account IDs, PII,
  PHI, or private customer/user data.

If raw private context is needed for local analysis, keep it in ignored
`.mimetic/local/private-dogfood/` and summarize only the public-safe conclusion
here.
