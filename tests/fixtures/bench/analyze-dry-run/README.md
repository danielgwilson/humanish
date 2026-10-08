# `humanish analyze --dry-run --json` outputs

Captured on 2026-10-08 from this repository's `dist/cli.js` (0.114.0 plus `admission.admittedCostUsd`)
on a copy of the third planted run of the 0.114.0 Taskly benchmark,
`cua-2026-10-08T00-21-52-120Z-c53f9610`. The copy left out the run's analyses and sandbox receipts.
Each file is the command's whole stdout. The expected cost, $1.182375, equals the `admissionUsd`
the live benchmark recorded for that run.

| File | Arguments after `analyze --run <id> --cwd <project> --json --dry-run` | Exit |
| --- | --- | --- |
| `auto-cap.json` | `--max-cost 7 --max-output-tokens 16384`, the benchmark's automatic sizing call | 0 |
| `refused.json` | `--max-cost 1.25 --max-output-tokens 16384` | 2 |
| `fixed-cap.json` | `--max-cost 1.31`, the benchmark's `--analysis-max-usd 1.31` call | 0 |

The same command admits at `--max-cost 1.300613`, the reported `admittedCostUsd`, and refuses at
`1.300612`.

The same `--max-cost 7 --max-output-tokens 16384` dry run on copies of all six 0.114.0 benchmark
runs reported these figures. Each expected cost equals the run's recorded `admissionUsd`.
`bench/lib/plan.ts` takes its typical analysis worst case, $1.26, from the mean of the last column.

| Run | Expected | Admitted | Worst case |
| --- | --- | --- | --- |
| `cua-2026-10-08T00-03-28-407Z-242cce4d` | 1.081825 | 1.190008 | 1.251025 |
| `cua-2026-10-08T00-08-07-063Z-af96375a` | 1.050938 | 1.156032 | 1.220138 |
| `cua-2026-10-08T00-11-57-121Z-cbc8bf15` | 1.156825 | 1.272508 | 1.326025 |
| `cua-2026-10-08T00-17-10-624Z-2056b6c0` | 1.0382 | 1.14202 | 1.2074 |
| `cua-2026-10-08T00-21-52-120Z-c53f9610` | 1.182375 | 1.300613 | 1.351575 |
| `cua-2026-10-08T00-27-42-385Z-d674cdc9` | 1.054638 | 1.160102 | 1.223838 |
