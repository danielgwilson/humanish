# Save feedback and session endings

These two synthetic Taskly fixtures test whether an automatic stop retains a
participant's report after they recover from a broken control. They are not a
general usability benchmark or a claim that the working variant is defect-free.

`feedback-working-save/` saves an edit through either Save or Enter.
`feedback-dead-save/` has a no-op Save click handler; Enter still saves.
The two variants differ only at that click handler. Both retain the original
120-character add-field limit; the short task names below do not exercise it.

Create four local lab variants using this template. Cross the two served
directories with either the shown `stopWhen` or its complete removal for a
natural ending. Use a fresh sandbox for every attempt, keep the model and
mission fixed, alternate cell order between repeats, and retain failures.
Three repetitions per cell make twelve attempts. The caps are checked at turn
boundaries; desktop billing and an in-flight request can add to spend.

```yaml
schema: humanish.lab.v2
id: feedback-ending-study
title: Save feedback study
description: Paired Save-control and session-ending diagnostic.
subject:
  source: local-tree
  serve:
    start: python3 -m http.server 8000 --directory bench/feedback-dead-save
    url: http://127.0.0.1:8000/
actors:
  - type: openai-computer-use
    model: gpt-5.6-sol
    persona: synthetic-new-user
    mission: You are using this to-do list for the first time. Add a task named
      Draft proposal, then rename that task to Send proposal. Stop once the
      renamed task is saved. When you finish, say what you did and anything that
      behaved differently from what you expected.
    stopWhen:
      any:
        - id: renamed
          textIncludes: Send proposal
execution:
  target: e2b-desktop
  timeoutMs: 300000
  caps:
    maxUsd: 1
    maxTotalUsd: 1
scenario:
  mode: live
policies:
  allowPrivateRepoAccess: false
  allowProviderCredentials: false
  allowGitHubMutation: false
  redactScreenshots: true
```

Score separately: attempted runs, completed tasks with saved-state evidence,
participant messages, accepted closing reports, feedback candidates and their
meaning, process exits, cost uncertainty, and provider cleanup. A candidate is a
review draft, not a confirmed defect. See the
[dated receipt](../docs/goals/computer-use-actor/receipts/structured-closing-report-2026-09-05.md)
for both the successful report recovery and false positives exposed by controls.

## Run from a source checkout

Use Node 20 or newer and pnpm, with `OPENAI_API_KEY` and `E2B_API_KEY` available
to the process. The live command below allocates a desktop and calls the model.
Twelve attempts each have a $1 model cap; desktop charges and an in-flight
request can add to that amount. A dry run checks configuration only.

```bash
git clone https://github.com/danielgwilson/humanish.git humanish-feedback-study
cd humanish-feedback-study
git checkout 169966525703d188b01edace72867e6bd54da988
pnpm install --frozen-lockfile
mkdir -p .humanish/labs
```

Save the template above as `.humanish/labs/feedback-ending-study.yaml`, then run:

```bash
pnpm exec tsx src/cli.ts run .humanish/labs/feedback-ending-study.yaml --dry-run --json
pnpm exec tsx src/cli.ts run .humanish/labs/feedback-ending-study.yaml --json
pnpm exec tsx src/cli.ts verify --run latest --json
```

That is one attempt. Create separate files for the four conditions and run each
three times, alternating conditions and retaining every run ID and failed start.
The pinned public revision has the closing report before the separate legacy
negation correction in #671. Current main includes that correction, so its
working/natural candidate counts should differ from the frozen receipt. The
fixture and runtime comparison is documented in that receipt; exact model
responses are not deterministic.
