# OpenAI egress auth: live transport receipt

Date: 2026-09-05. Implementation: `081431f` (terminal auth mode). This receipt
covers the raw-key placement and HTTPS transport, not a preventive spending
limit or broad study efficacy.

## Controlled transport probes

Three E2B Desktop sandboxes were created and reclaimed serially with
`@e2b/desktop` 2.3.3 and its resolved `e2b` 2.46.1 dependency. Each received an
exact `api.openai.com` Authorization transform. A separate `httpbin.org` rule
carried only a harmless custom-header canary; the OpenAI key was never sent to
the echo service. No inference request was made in these three probes.

| Check | Observed result |
| --- | --- |
| Default Python TLS trust, first two allocations | Certificate verification failed on transformed hosts; no HTTP authentication result |
| Existing E2B system CA bundle, third allocation | TLS verification stayed enabled; both canary requests returned HTTP 200 and the transformed value replaced the caller's value (2/2 requests in one sandbox) |
| OpenAI `GET /v1/models`, third allocation | HTTP 200 with `object: list` and a data array, while the caller supplied only the inert bearer placeholder |
| Readable process environments, third allocation | 134 checked; no value matched the host-held runtime key's SHA-256 digest |
| Scoped readable files, third allocation | 16 checked, none skipped, up to 2 MiB each; no token matched the runtime key's digest |
| Sandbox command environment | No `OPENAI_API_KEY`; `CODEX_API_KEY` held the inert placeholder |
| Cleanup | All three exact-id kill calls returned true, followed by `SandboxNotFoundError` from exact-id `getInfo` |

The file scan covered the sandbox user's home, `/tmp`, `/etc/environment`, and
`/etc/profile.d`. It compared candidate token hashes without sending the raw key
into the sandbox. This limited readback is evidence about those environments
and files; it is not an exhaustive memory/filesystem exfiltration proof.

The first failures exposed a real integration requirement: the stock image's
OpenSSL default CA file was absent, while E2B had installed its proxy CA in
`/etc/ssl/certs/ca-certificates.crt`. The successful probe explicitly loaded
that existing system bundle. The implementation supplies its path through the
[documented Codex `CODEX_CA_CERTIFICATE` channel](https://developers.openai.com/codex/auth#custom-ca-bundles).
It does not disable TLS verification or fetch an unauthenticated CA.
[E2B's CA installer](https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/host/cacerts.go)
describes the system bundle and per-sandbox certificate installation.

## Limits and usage

These checks demonstrate header replacement and successful authentication with
the raw runtime key outside the sandbox command environment. Every sandbox
process still has authenticated access through the OpenAI proxy until teardown,
including bootstrap/setup processes. Direct calls outside Codex may not appear
in its usage ledger. Neither this mode nor a routing allowlist establishes a
provider-enforced spending limit.

No model inference was requested by these transport probes. E2B billing for the
three short allocations was not available; it is unknown, not zero. Real
terminal actor compatibility is a separate check and is not established by the
transport probes alone.
