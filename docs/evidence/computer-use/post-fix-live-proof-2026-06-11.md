# Receipt: post-fix live proof that the CUA actor acts (0.6.1)

Date: 2026-06-11. Version: homun 0.6.1 (main, v0.6.1 tag). Operator: maintainer
session; run bundle retained locally under the gitignored `.homun/` plane (receipts
carry numbers and digests, never bundles or pixels).

## Why this receipt exists

PR #134 fixed the parser bug that made the computer-use actor execute zero actions in
0.3.0–0.6.0 while runs false-passed as `goal_satisfied`. Its PR body claimed live runs
now show real engagement — but no kept artifact backed that claim, which is the same
evidence class that failed before. This receipt is the kept artifact.

## The run

Lab (`homun.lab.v2`, live mode): `subject.source: clone` of the public repo
`mdn/beginner-html-site-styled`, served in-sandbox via `python3 -m http.server 8000`,
actor `openai-computer-use` (persona `first-time-visitor`), execution `e2b-desktop`.
Mission: state the page's main heading text exactly, then stop.

- Run id: `cua-2026-06-11T17-04-01-761Z-395d9289`
- Cloned commit: `16a0f38ba6d5a17b22a1dd61ff06afe95cb17888` (provenance pinned)
- Session: `passed` / `goal_satisfied`, reason: `Mozilla is cool`
- Engagement counts: **2 turns, 1 model-issued action, 2 screenshots, 1 message**
  (`tokenUsage 3448 in / 40 out`); session duration 7.1s; sandbox killed on teardown
- `homun verify --run latest`: ok, 8/8 checks
- Subject env names: none declared, none provisioned

## Verification beyond the run's own verdict

Per the 0.6.1 lesson ("look at the screenshot, don't trust the assertion"), the raw
full-fidelity frame `screenshots/turn-01.png` was inspected directly: the sandbox
browser shows the served clone at the declared loopback URL with the main heading
**"Mozilla is cool"** — which is exactly the text the model reported in its final
message. The model demonstrably observed the screen and answered from it.

## Contrast with the pre-fix specimen

The same lab run on 0.5.0-era code (preserved locally as a regression specimen)
reports `goal_satisfied` with **1 turn, 0 actions, 0 messages** after a 4.3s empty
session — the hollow pass. Same lab, same mission, opposite evidence. The producer-side
no-engagement guard (0.6.1) and the verify-side check (follow-up PR) exist so the
hollow shape can never read as a pass again.
