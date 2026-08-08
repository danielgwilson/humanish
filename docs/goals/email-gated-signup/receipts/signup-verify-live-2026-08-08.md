# Live rung: a persona completed an email-gated signup, 2026-08-08

The flow humanish exists to study, observed end to end for the first time.

**Run:** `cua-2026-08-08T22-47-27-916Z-ccc945af`
**Lab:** `humanish/labs/signup-email-verify.yaml`
**Subject:** `documenso/documenso@f0ab7c112e3c` (public, AGPL-3.0), cloned and served in-sandbox
**Actor:** `openai-computer-use`, persona `synthetic-new-user`
**Verdict:** `passed` / `goal_satisfied` — 18 turns, 34 actions, $0.51

## What was proven

A persona created an account, the app emailed a verification link, the persona opened its
inbox, followed the link, and reached the signed-in product. Every step was real except that
the mail was captured in-sandbox and never left the machine.

The subject was chosen so the result could not be faked by a persona clicking past a welcome
screen: documenso's registration returns no session, and sign-in refuses an unverified
account. Reaching the dashboard is only possible by actually reading the mail.

Session summary, as recorded:

> Signed up with `signup@example.test`, completed email verification via the local inbox, and
> reached the signed-in dashboard.

## Evidence

- `comms/thread.json` — `humanish.comms-thread.v1`, `count: 1`, one captured message with
  digest-only from/to/subject/link fields and `codeCount: 6`. The raw address appears zero
  times in the artifact.
- `screenshots/turn-12.png` — the persona reading its inbox at `127.0.0.1:8025/inbox`:
  *"Please confirm your email"*, from `noreply@example.test` to `signup@example.test`.
- `screenshots/turn-17.png` — signed in at `localhost:3000/t/personal_…/documents` as
  "Test Maintainer", with the confirmation tab still open beside it.
- `humanish verify --run cua-2026-08-08T22-47-27-916Z-ccc945af` — passed, all 16 checks,
  including actor engagement and actor verdict consistency.

Screenshots are full-fidelity and stay in gitignored `.humanish/`. Verify reports
`share-safety: local_only` for exactly that reason; this bundle is not share-ready as-is.

## What it took to get here

Each of these cost a real sandbox to find, and each is now either fixed in the harness or
recorded in the lab's own comments so the next person does not pay again.

**In the harness:**

- The stock desktop template has no Node, so `npm install` died at exit 127 after a sandbox
  had been paid for. The harness now provides the runtime (#371).
- The catch spoke only HTTP provider APIs. Most self-hostable apps — documenso included —
  send over SMTP, so the catch now speaks SMTP and normalizes it onto the same captured-send
  shape.
- A lab could not commit an app's non-secret configuration, so reproducing a study meant
  carrying a private env file. `subject.envValues` fixed that, and refused a Postgres URL
  with a password in it, which is how this lab ended up using trust auth and committing no
  credential at all.
- A session budget generous enough to finish this flow derived a sandbox deadline the
  provider rejects. That is now refused at plan time with the arithmetic shown, rather than
  as a raw 400 after the plan has printed.

**In the subject, recorded in the lab:**

- `service postgresql start` is a no-op in a container; the cluster needs `pg_ctlcluster`.
- `pg_hba.conf` matches first-rule-wins, so the trust rule must be prepended, not appended.
- `npm ci` refuses because documenso's committed lockfile is out of sync with its own
  `package.json` upstream.
- `prisma migrate deploy` alone is not enough: documenso imports zod schemas that
  `prisma generate` emits, so the dev server starts and then every route 500s.

## What this does not prove

One run, one persona, one subject. It shows the pipeline works end to end; it says nothing
about how often it works, how a different persona would behave, or whether the flow is easy
for a human. The interesting studies start here rather than end here.

The cost figure is also newly trustworthy and worth noting: 223,616 of 293,532 input tokens
were served from the provider's prompt cache. Before the meter learned to price cached input,
this same run would have reported roughly $1.47 instead of $0.51.
