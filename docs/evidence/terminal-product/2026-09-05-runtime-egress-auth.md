# OpenAI egress auth: live transport and actor receipt

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

No model inference was requested by these transport probes. E2B billing was not
available; it is unknown, not zero.

## Real terminal actors and the bootstrap control

The first full terminal-engine attempt failed before Codex started: the stock
Node/npm bootstrap reached its 300-second timeout while updating Ubuntu package
indexes. A short diagnostic reached unrelated public HTTPS hosts under the new
mode, but the Ubuntu archive HTTP endpoint timed out. A separate sandbox with no
network rules reproduced that archive timeout. This was not treated as evidence
of an auth-mode regression or as product-user friction.

Two subsequent terminal actors used an explicitly prepared runtime: official
Node 22.23.2 for Linux x64, downloaded over verified HTTPS and checked against
the official SHA-256 manifest before the unchanged engine bootstrap. Both used
`gpt-5.4-mini` with low reasoning effort, a three-minute command bound, and the
new `openai-egress` mode. Their missions were to discover Humanish from public
website/docs surfaces, complete a provider-free first evidence step, and inspect
verification. They were not controlled before/after documentation cohorts.

| Retained run | Actor result | Bundle verification | Post-actor raw-key readback | Cleanup |
| --- | --- | --- | --- | --- |
| `terminal-egress-prepared-20260905-actor-1` | Passed, nonce-verified final verdict | `share_ready` | No match in 168 process environments and 500 scanned files; 6,318 files skipped | Exact-id kill + not-found confirmation |
| `terminal-egress-prepared-20260905-actor-2` | Passed, nonce-verified final verdict | `share_ready` | No match in 168 process environments and 500 scanned files; 6,332 files skipped | Exact-id kill + not-found confirmation |

The post-actor file scan covered Codex state, the scratch study directory, and
`/tmp`, capped at 500 readable regular files of up to 2 MiB each. Its skipped
files and unexamined memory remain outside the claim. Both real command envs
contained only the inert `CODEX_API_KEY`, the nonsecret system CA bundle path,
and the study-participant marker. Both resolved traces recorded external key
placement. The original stock-bootstrap failure remains a limitation; prepared
runtime success does not prove that the unavailable package mirror recovered.

All eight allocations in this receipt were reclaimed by exact ID: three
transport probes, one failed stock-bootstrap attempt, one routing diagnostic,
one no-rules control, and two prepared-runtime actors.

The two actors also exposed an existing capture defect: each final SDK stdout
value exactly repeated all earlier stdout callback chunks. The terminal producer
persisted both deliveries, doubling the usage entries ([follow-up #667](https://github.com/danielgwilson/humanish/issues/667)). The original bundles
remain unchanged; the operator's cost analysis counted each proven complete
delivery once. At the [published GPT-5.4-mini rates](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
for the model declared in the setup, the two unique usage records imply a
**$0.0759273 model-cost estimate**, not an invoice. The duplicated persisted
counts would imply twice that amount. E2B billing and any calls outside the
observed Codex stream were not measured.
