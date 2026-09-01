# Cold install to first live study: 3 of 3, under two minutes each

Date: 2026-09-01. Package under test: `humanish@0.65.0` as published on npm (not a checkout).
Question: does the starter lab `init` writes run live on a machine that has never seen humanish,
with nothing edited?

## Procedure

Three fresh directories, launched 20 s apart, each doing exactly what the README says:

```bash
npm init -y
npm i -D humanish@0.65.0 @e2b/desktop
npx humanish init --yes
npx humanish run try-live --no-open --json
```

`OPENAI_API_KEY` and `E2B_API_KEY` were in the environment, `DO_NOT_TRACK=1` so these runs do
not count as adopters. `init` chose `type: openai-computer-use` for `try-live` (a provider key
was present; with only a signed-in coding agent it writes `local-agent`). Nothing was edited.

## Result

| run | install | `run try-live` wall clock | session | cost |
|---|---|---|---|---|
| `cua-2026-09-01T18-51-13-111Z-6dc85b53` | 3 s | 111 s | passed, goal_satisfied, 10 screenshots | $0.165 |
| `cua-2026-09-01T18-51-32-117Z-97d3ecee` | 2 s | 111 s | passed, goal_satisfied, 10 screenshots | $0.160 |
| `cua-2026-09-01T18-51-52-180Z-b1a6ce31` | 2 s | 108 s | passed, goal_satisfied, 10 screenshots | $0.160 |

Every bundle: `review.verdict: pass`, `participants: 1/1 reached the goal`, `verify` clean.

Where the 110 s goes (run 1, from the CLI's own stderr): clone drawDB 3.5 s, provide the Node
runtime the stock desktop lacks 21.9 s, `npm install` 15.8 s, `npm run build` 6.6 s, server ready
1.7 s. The participant's session is the remaining ~55 s.

## The finding the lab produces out of the box

All three participants, independently, reported the same two frictions in drawDB:

- "Add table" creates a table with a long random name and no prompt; renaming is not obvious
  (two tried double-clicking the canvas before finding the sidebar `Name` field).
- Every new table lands at the same canvas position, on top of the previous one.

Three of three is a replicated observation, not an anecdote. The second one is the same defect a
participant on 2026-08-19 could not work around at all (#476: "every new table appeared directly
on top of the previous one"). It is real, it is reachable in a two-table task, and the starter lab
finds it for sixteen cents.

## What this does and does not say

- It says the `init` → first live run path works unmodified on 0.65.0. #505 (placeholder starter
  URL) is closed in practice as well as on paper.
- `participants.reportedFriction` is `0` on all three while each report names two frictions. The
  counter is for self-reported *blockers* (a participant who could not proceed), and none of these
  three was blocked. The frictions live in the structured report. Worth knowing when reading a
  tally: `reportedFriction: 0` does not mean "nothing to read".
- N=3 on one machine with one provider key. It does not measure the `local-agent` route that a
  keyless machine with a signed-in coding agent gets, and it does not measure a machine without
  `gh` (the CLI read `GH_TOKEN` from `gh auth token` here).
