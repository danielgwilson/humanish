# Public Readiness Standard

Status: researched working standard for public repository and npm release hygiene.

This document separates real public-release risk from preference cleanup. The
goal is to keep `humanish` safe, useful, and professional without deleting the
durable context future contributors and agents need.

## Sources Reviewed

- [GitHub Docs: Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [GitHub Docs: Setting your commit email address](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
- [GitHub Docs: Email addresses reference](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)
- [GitHub Docs: About secret scanning](https://docs.github.com/code-security/secret-scanning/about-secret-scanning)
- [GitHub Docs: About push protection](https://docs.github.com/en/code-security/concepts/secret-security/about-push-protection)
- [npm Docs: package.json files field](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)
- [npm Docs: npm publish package contents](https://docs.npmjs.com/cli/v9/commands/npm-publish#files-included-in-package)
- [npm Docs: Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- [OpenSSF Scorecard](https://scorecard.dev/)
- [OpenSSF Source Code Management Platform Configuration Best Practices](https://best.openssf.org/SCM-BestPractices/)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

## Decision Model

Use four categories.

### 1. Public Blockers

These must be removed from the current tree, package payload, generated docs,
screenshots, logs, and reachable history before the repo is public.

- Secrets: API keys, provider tokens, npm/GitHub tokens, private keys, cookies,
  session URLs, database URLs with credentials, `.env` values, auth-bearing
  request headers, and raw credential material.
- PHI, patient data, customer data, private user identifiers, private emails,
  phone numbers, addresses, account IDs, billing IDs, raw transcripts, and raw
  screenshots from private systems.
- Private source snippets, internal-only product names, private roadmaps,
  incident details, or operational data that would expose a non-public system or
  customer relationship.
- Built package output, source maps, docs, fixtures, or image assets that contain
  any of the above.

If a real secret was exposed, revoke or rotate it first. GitHub explicitly warns
that history rewriting has side effects and may not be warranted once the secret
is revoked. Rewrite history only when sensitive data remains materially risky
after revocation, or when privacy, legal, contractual, or proprietary-source
obligations require removal.

### 2. Release-Gate Hygiene

These should fail CI or release checks until fixed, but they are not all reasons
to rewrite history.

- Package payload is not inspected with `npm pack --dry-run`.
- Scanner only checks tracked source and misses built `dist`, source maps, docs
  packaged by `files`, or generated assets.
- Binary public assets are not approved by path and checksum.
- Docs link to files that are not shipped or not reachable from the public repo.
- Runtime artifacts are included: `.humanish/`, run bundles, transcripts,
  disposable clones, `.firecrawl/`, `.e2b/`, logs, tarballs, caches.
- GitHub Actions use broad default permissions where read-only is enough.
- Publish workflow uses long-lived npm tokens when OIDC trusted publishing is
  available.
- Secret scanning, push protection, or equivalent local scanners are absent from
  the operating checklist.

### 3. Acceptable Public Metadata

These are acceptable when intentional and public-safe. They should not trigger
panic cleanup or history rewrite by default.

- Maintainer name, GitHub username, public repo owner, public issue links, and
  public repository URLs.
- A maintainer-approved public commit email. GitHub allows either a noreply
  address or any configured email for commits. Noreply is a privacy preference,
  not a universal public-release requirement.
- Env var names without values, such as `OPENAI_API_KEY` or `E2B_API_KEY`.
- Synthetic personas, synthetic screenshots, synthetic app data, and redacted
  proof examples.
- Public-safe ramp, goal, architecture, and roadmap docs that help future
  contributors continue the project.

### 4. Professionalism Cleanup

These do not usually justify history rewrite, but they matter for an open-source
repo people will judge quickly.

- Chat residue, private-process phrasing, or emotional notes that do not help a
  public maintainer.
- Overly specific local machine paths or private workspace names, even when not
  security-sensitive.
- Broken links, stale commands, claims of product proof where only contract proof
  exists, and docs that depend on private chat memory.
- Screenshots that are technically synthetic but look sloppy, confusing, or
  embarrassing.

Professionalism cleanup should preserve useful context. Deleting all ramp or
goal docs is worse than rewriting them into a public-safe form.

## Commit Email Policy

Noreply commit emails are preferred for privacy and consistency.

Allowed commit metadata:

- GitHub's two documented personal-account noreply forms:
  `ID+USERNAME@users.noreply.github.com` and
  `USERNAME@users.noreply.github.com`. The username-only form remains valid for
  accounts using GitHub's pre-July 18, 2017 privacy form.
- `github-actions[bot]@users.noreply.github.com` for GitHub Actions commits.
- `noreply@github.com` for GitHub-generated commits.
- Explicitly approved public maintainer emails.

Blocked commit metadata:

- Unknown personal emails.
- Contractor, employee, patient, customer, vendor, or private-domain emails that
  are not intentionally public for this project.
- Any email that appears in logs, transcripts, screenshots, or docs as private
  user/customer data rather than maintainer metadata.

Do not force-rewrite `main` solely because a known maintainer-approved public
email appears in a commit. Document the approval and update the scanner
allowlist instead.

## NPM Package Surface

The npm package is its own public surface. The release gate must inspect:

- `npm pack --dry-run --json` output;
- compiled `dist`;
- source maps;
- all files matched by `package.json.files`;
- always-included files such as `package.json`, `README.md`, and `LICENSE`;
- docs, skills, screenshots, and other assets shipped for npm-page display.

The package should use the `files` field as an allowlist, but that is not enough.
The scanner must union tracked source files with the actual npm dry-run payload.

Public binary assets are allowed only when:

- the asset is intentionally public;
- the asset is synthetic or redacted;
- the path is allowlisted;
- the SHA-256 checksum is pinned in the scanner.

## GitHub And Supply Chain Posture

Minimum public-repo posture:

- branch protection or rulesets for `main`;
- required CI before merge;
- workflow permissions narrowed to read-only unless a job needs more;
- no long-lived npm token in Actions for publish;
- npm trusted publishing via OIDC where possible;
- secret scanning and push protection enabled where available;
- `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, and clear issue flow;
- periodic OpenSSF Scorecard or equivalent review.

Nice-to-have after public launch:

- dependency update automation;
- CodeQL or comparable SAST;
- release provenance and staged publishing where practical;
- signed releases when the release process matures.

## Humanish Application

For `humanish`, the honest standard is:

- Keep `docs/ramp/` and `docs/goals/` if they are public-safe. They are essential
  project memory for future coding agents and contributors.
- Keep the package docs and skill docs focused on public install, public-safe
  examples, and synthetic proof.
- Do not commit `.humanish/`, `.firecrawl/`, screenshots from private systems,
  raw run bundles, private transcripts, local env files, or packed tarballs.
- Treat `dist` and source maps as public and scan them.
- Treat the README screenshot as public and checksum-gated.
- Allow a maintainer-approved public email in commit metadata; do not classify it
  as a secret.
- Rewrite history only for actual sensitive data, private source, or private
  identity/customer data that remains materially risky.

## Practical Checklist

Before making the repository public or cutting a public package:

```bash
pnpm install --frozen-lockfile
pnpm release:check
git diff --check
npm pack --dry-run --json
```

Also verify in GitHub:

- `main` branch protection/ruleset is active;
- secret scanning and push protection are enabled where available;
- publish workflow uses OIDC trusted publishing;
- failed workflow logs do not contain real secrets or private data;
- visible issues, PRs, labels, and project metadata do not expose private context.

If a check fails, classify it before reacting:

1. Secret/PHI/private source? Rotate/revoke first, then consider history rewrite.
2. Package leak or private artifact? Remove from package/tree and rerun gates.
3. Unknown private identity metadata? Approve, redact, or rewrite based on risk.
4. Public maintainer metadata? Usually allowlist and document.
5. Sloppy public docs? Rewrite, do not delete useful project memory.
