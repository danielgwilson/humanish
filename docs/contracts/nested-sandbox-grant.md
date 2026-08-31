# The nested sandbox grant

*Letting a study create studies — the narrowest credential grant that makes the end-to-end
dogfood test possible, and nothing wider.*

## The test this exists for

humanish is built on a premise: **a coding agent sets it up for someone.** We had proved the agent
can install humanish, scaffold a lab, run a dry study, and report back. We had not proved it can
take a person all the way to a **real** study, because a live run needs an E2B key, and the
terminal lane deliberately ships no provider-credential channel at all.

That last mile is the part that matters. A first-run funnel that ends at a dry run is a funnel that
ends before the product does anything. Everything below exists so that one test can run without
handing an autonomous agent an unbounded lease on somebody's money.

## Why `allowProviderCredentials: true` was never enough

That policy field records *intent*. It grants nothing, and that is deliberate: handing an
autonomous agent inside a sandbox a credential that spends money is the most dangerous thing this
codebase could do. The existing safety contract presumes any injected key is exfiltratable.

So the grant bounds the blast radius **by construction**, not by trust.

## The five properties

1. **A distinct variable.** The grant reads `HUMANISH_NESTED_E2B_API_KEY`, never `E2B_API_KEY`. An
   operator who simply has the usual variable exported cannot trigger this by accident.
2. **Not the operator's own key.** Refused outright if the values match.
3. **Proven project isolation, before injection.** Value comparison catches the obvious mistake but
   not the subtle one: two different keys can belong to the *same* project, where the separate
   budget does not exist. E2B scopes every key to exactly one project and a key can only list its
   own project's sandboxes — so humanish asks the granted key whether it can see *this run's own
   sandbox*. If it can, the keys share a project and the run fails closed with the credential never
   injected. An unverifiable grant is a refused grant.
4. **Command-scoped injection only.** The key goes in `commands.run({ envs })` for the single codex
   exec, exactly like the runtime LLM key — never `Sandbox.create({ envs })`, never the image, never
   a file. Its value joins the redaction set, so it cannot reach a transcript.
5. **A swept teardown.** When the study ends, humanish lists the *granted* project and kills what it
   finds, recording `found`/`killed` in the cleanup ledger. A grant without a sweep is an unbounded
   lease: the agent finishes, its sandboxes keep running, and the budget drains after everyone has
   stopped watching.

Note how property 5 relates to safety contract item 8 ("never `Sandbox.list`"). That rule protects
the **operator's** key from ever reaching a sandbox it did not create. The sweep lists the *granted*
project, which by property 3 is provably not the operator's, and which by construction contains
only what the grant made. Both the list and the connect calls pass the granted key explicitly —
`SandboxLister.list` makes `apiKey` **required** even though the SDK makes it optional, because an
omitted key silently falls back to `process.env.E2B_API_KEY` and would turn the sweep into an
account-wide kill against the operator.

## What the operator must do

One thing only they can do: **create a separate E2B project and set a spending limit on it.** E2B
exposes budgets in the console (`console.e2b.dev/?tab=budget`), not the API, so humanish cannot set
this for you and does not pretend to. The project is the billing and resource boundary; the limit is
what makes "bounded" a number rather than a hope.

```bash
# In the project that will host the participant's sandboxes — NOT your usual one.
export HUMANISH_NESTED_E2B_API_KEY=...
```

```yaml
execution:
  runtimeAuth: openai-env
  nestedSandboxAuth: e2b-env-scoped   # absent = no provider credential reaches the agent
```

## Where this sits against current practice

OWASP's Top 10 for Agentic Applications (2026) names this risk class **ASI03: Identity & Privilege
Abuse** — "per-agent identity with short-lived, task-scoped credentials is the baseline control" —
and **ASI08: Cascading Failures**, whose prescription is strict environment separation. The design
above gives the participant its own identity (never a borrowed operator credential), separates the
environment, and revokes the resources afterwards.

It does **not** give a short-lived credential, and E2B's own answer to that is worth naming
precisely, because it is the direction this should move:

- **Workload identity** (`iam.tokens` on `Sandbox.create`) issues short-lived, audience-scoped
  tokens instead of long-lived secrets — the ASI03 baseline control, shipped. It is in **private
  beta** (access is request-only through E2B support), so it is not available to us today.
- **Per-host request transforms** (`network.rules`) are in **public beta and usable now**. They let
  the *egress proxy* attach the credential to outbound requests for one host, which means the key
  would never exist inside the sandbox at all — an agent cannot exfiltrate a value it never holds.
- **Domain egress allowlisting** (`allowOut` + `denyOut: allTraffic`) is **GA** and would bound
  where anything in the sandbox can talk to.

The grant does not use these yet, and the reason is sequencing rather than preference: an egress
allowlist changes behavior for every terminal run, and a wrong host list fails studies in ways that
look like product bugs. It needs its own live verification, which is blocked on the same separate
project this feature is. Tracked as follow-up work; the shipped design is the strongest one
buildable from GA features alone.

The compensating controls meanwhile are the required spending limit, the proven isolation check,
the single-exec injection window, the redaction set, and the sweep. **Rotation remains the
operator's job** — humanish cannot rotate a key it was handed. If a run's transcript were ever
exposed, treat the granted key as burned and issue a new one from the console.
