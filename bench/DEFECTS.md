# Planted defects in `bench/taskly-planted`

Five defects, each reachable by a persona doing ordinary tasks. None requires reading source.
`bench/taskly-clean` is byte-identical except for `app.js`.

| id | defect | how a persona hits it | severity |
|----|--------|----------------------|----------|
| D1 | `Clear completed` does nothing | complete a task, click the button, the task stays | dead control |
| D2 | task text over 30 chars is silently truncated | add a long task, it appears cut with no warning | silent data loss |
| D3 | `Active` and `Completed` filters are swapped | complete one of two tasks, click Active, see the wrong one | mislabeled control |
| D4 | empty list renders the literal text `undefined` | open the app before adding anything | broken empty state |
| D5 | `Save` in edit mode does nothing; only Enter commits | click Edit, change the text, click Save, nothing happens | impossible step |

## Scoring

- **Recall** on the planted build: how many of D1 to D5 appear in the run's feedback draft.
- **Precision** on the clean build: findings reported against a build with no planted defects.
  A tool that reports five problems on the clean app has a precision problem, and that is the
  failure mode synthetic-user tooling is most criticised for. Both arms get the same personas,
  the same mission, and the same number of runs.

## What this number is not

Planted defects are not a representative sample of real ones. They are more legible, more
self-contained, and more reachable than most production bugs. Recall here is an upper bound on
recall in the wild, and should be reported that way.
