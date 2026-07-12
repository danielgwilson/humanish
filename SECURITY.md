# Security Policy

## Public-Safety Boundary

Humanish must not contain or emit PII, PHI, secrets, keys, tokens, raw private
transcripts, private screenshots, private customer data, private patient data,
or private source snippets.

Do not file public issues that contain sensitive data. Redact the data and
describe the class of problem instead.

## Reporting A Vulnerability

If you find a security issue, open a minimal public issue only when the report
does not disclose exploitable details or sensitive data. Otherwise, contact the
maintainer privately through the repository owner profile.

Include:

- affected version or commit;
- command run;
- safe reproduction steps;
- redacted evidence path or synthetic fixture;
- whether any generated `.humanish/` artifact may contain sensitive data.

## Maintainer Release Checks

Before any public release, run:

```bash
pnpm check
pnpm public-surface:scan
pnpm pack:dry-run
```
