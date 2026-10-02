# Security policy

## Report a vulnerability privately

Report a vulnerability through GitHub private vulnerability reporting:
<https://github.com/danielgwilson/humanish/security/advisories/new>. Only you and the maintainer
see the report until a fix ships. If you cannot use GitHub, email the maintainer at the address in
`package.json`'s `author` field.

Include:

- the affected version or commit;
- the command you ran;
- safe steps to reproduce it;
- a redacted evidence path or a synthetic fixture;
- whether a generated `.humanish/` artifact may contain sensitive data.

## Keep sensitive data out of public issues

humanish must not contain or emit PII, PHI, secrets, keys, tokens, raw private transcripts,
private screenshots, private customer data, private patient data or private source snippets.

Do not file a public issue that contains sensitive data. Redact it and describe the kind of
problem.
