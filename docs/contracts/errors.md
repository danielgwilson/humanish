# Error codes

A failed command or library call reports a code and a message. The code is the stable part: a
rename or removal gets a CHANGELOG entry in the release that makes it. Messages may change in any
release.

## Where a code appears

- `--json`: the envelope has `ok: false` and `error: { code, message }`, and the command exits 2.
  This output is the interface for scripts and agents. Two exceptions:
  - A command-line usage error, such as an unknown option or a missing argument, prints
    Commander's message on stderr, exits 1 and prints no JSON.
  - `keys` and the `comms` connection commands report a failure as `ok: false` with a `message`
    and no `error` field.
- Human mode: two or three lines on stderr.

  ```text
  humanish run failed: Lab not found: nope-lab. Look in humanish/studies/ or humanish/labs/, or pass a .yaml path.
  code: HUMANISH_STUDY_NOT_FOUND
  next: humanish lab list
  ```

  A result with no code (`keys`, `comms`) prints no `code:` line. The `next:` line comes from a
  table in `src/cli/io.ts` keyed by code, which today holds `HUMANISH_STUDY_NOT_FOUND`. Other
  codes get no `next:` line, though some messages name a command, as the run-not-found message
  names `humanish runs`. Stdout keeps a result's other lines: a failed run
  prints its run id, route and participants there, and a failed `verify` prints its failing
  checks there, since they are its result. Before 0.108.0, human mode printed the code and message
  on stdout.

- Library: the result objects `runLab` and the analysis entry points return carry the same
  `error.code`.

## Families

| Family                 | Codes | Emitted by                                                               | Appears in                                                              |
| ---------------------- | ----- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `HUMANISH_*`           | 137   | every CLI command and route result                                       | JSON `error.code`, library `error.code`, human `code:` line             |
| `ANALYSIS_*`           | 86    | `humanish analyze` and the analysis service (`src/analysis/`)            | JSON `error.code` of analysis results                                   |
| `AUTOMATIC_ANALYSIS_*` | 21    | the post-run analysis job                                                | `automaticAnalysis.reason` on a run result and the job record           |
| `analysis_*` lowercase | 29    | analysis execution                                                       | `error` fields in analysis artifacts and execution receipts             |
| `codex_*` lowercase    | 13    | the Codex CLI readiness check (`src/actors/codex/`, `src/lab/doctor.ts`) | doctor rows and analysis readiness, such as `codex_unsupported_version` |

Counts are the distinct quoted codes in `src/` on 2026-10-03.

The lowercase families are values recorded inside artifacts and receipts, and an artifact keeps
the code it was written with. Automatic analysis reads two of them back:
`analysis_admission_estimate_exceeded` becomes the reason `AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED`,
and `analysis_budget_exceeded` on a default analysis prints the hint to rerun with
`humanish analyze --max-cost`. Validation also accepts a partial artifact whose error is
`analysis_admission_estimate_exceeded`.

Share-safety reasons in `humanish verify` (`VERIFY_FAILED`, `RAW_SCREENSHOTS` and the rest) are
grades, not errors; [run-bundle.md](run-bundle.md) lists them.

## Renames

0.108.0 renamed the codes that said lab: `HUMANISH_LAB_*` is `HUMANISH_STUDY_*`,
`HUMANISH_CUA_LAB_*` is `HUMANISH_COMPUTER_USE_*`, `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_*` is
`HUMANISH_SHARED_WORLD_*`, and the terminal and scripted families drop `_LAB`. It also renamed
`HUMANISH_INVALID_SIM_COUNT` to `HUMANISH_INVALID_PARTICIPANT_COUNT`. A run saved before a rename
keeps the codes it was written with.
