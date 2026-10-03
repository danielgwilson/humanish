# 0.107 run records

Five saved runs, written by the 0.107 run writers before run records gained `study`. Readers must
keep reading them through 0.109 and after (DESIGN.md section 5, "Saved runs"). Tests copy each
directory to a temp project's `.humanish/runs/<runId>/`.

| Run | What it is | Its study, as 0.107 records it |
|---|---|---|
| `fanout-source` | A live computer-use fan-out of four participants. One failed (`power-user`) | `lab` in run.json and status.json |
| `fanout-rerun` | The rerun of `fanout-source`'s failed participant | `lab` in run.json and status.json |
| `status-backed` | A preview of `first-run` | `lab` in run.json and status.json |
| `bundle-only` | The same preview with no status.json | `lab` in run.json |
| `source-convention-only` | A library run of the fan-out study, with its status.json removed as runs before status.json lack one. The library sets no `lab` | only the `lab:fanout-proof` persona and scenario sources |

The fan-out runs come from the fakes in tests/routes/computer-use/lab.fanout.test.ts. The previews
come from `humanish run first-run --run-id <id>`. Only run.json, status.json, events.ndjson,
actors/ and review files are kept. The screenshots are not committed, since the public-surface scan
admits only reviewed binary files. SCREENSHOTS.txt lists the paths the bundles name, and the test
writes a 1x1 PNG at each, which verifyRun accepts.
