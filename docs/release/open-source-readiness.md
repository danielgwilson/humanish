# Open-Source Release Readiness

Date: 2026-06-01

Status: dry-run ready. Actual public release is blocked on Daniel choosing the
license and explicitly approving npm publication.

## Current Package State

- Package name: `mimetic-cli`
- Binary: `mimetic`
- Repository: `https://github.com/danielgwilson/mimetic-cli`
- Package is intentionally `private: true`
- License is intentionally `UNLICENSED`
- No npm publication is authorized yet

Do not remove `private: true`, change `license`, add a `LICENSE` file, or run
`npm publish` until Daniel confirms the license and publish timing.

## Public Boundary

This repository is expected to become public. Release work must not include PII,
PHI, secrets, keys, tokens, raw private transcripts, private screenshots, raw
customer data, raw patient data, private source snippets, or generated run
bundles.

Allowed examples are synthetic or redacted only.

## Required Gates

Run these before any public release candidate:

```bash
pnpm install
pnpm check
npm pack --dry-run
git diff --check
rg -n "(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|BEGIN (RSA|OPENSSH|PRIVATE)|password\\s*=|secret\\s*=|token\\s*=|api[_-]?key\\s*=|patient|PHI|PII|raw private|private screenshot|private transcript|customer data)" README.md AGENTS.md docs src tests fixtures package.json pnpm-lock.yaml
```

Expected safety-scan matches are public-boundary policy language and historical
ramp summaries. Any credential-looking token, real user data, raw private
artifact, or unexplained private-source detail blocks release.

## Dry-Run Publish Procedure

Use dry-run packaging only:

```bash
pnpm pack:dry-run
```

Inspect the tarball list. The package should include compiled `dist`, package
metadata, and README only. It should not include `.env*`, `.mimetic/`, generated
run bundles, private screenshots, raw transcripts, or local npm credentials.

The `.gitignore` blocks `.mimetic/`, proof/runtime artifacts, `.e2b/`, `.env*`,
`.npmrc`, and packed `*.tgz` files.

## Human Decisions Before Publish

Daniel must decide:

- open-source license;
- whether to remove `private: true`;
- initial version number;
- npm organization/package ownership;
- publish timing.

After those decisions, a release PR should add `LICENSE`, update
`package.json`, rerun all gates, and only then run:

```bash
npm publish --access public
```

No agent should run that command without explicit human approval in the current
thread.
