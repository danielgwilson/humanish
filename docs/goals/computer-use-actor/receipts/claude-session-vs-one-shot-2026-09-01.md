# Does the Claude participant's memory across turns change the study? On try-live, no

Date: 2026-09-01. Lab: the `try-live` starter with `localAgent: claude`, keyless (only
`E2B_API_KEY`), subject drawDB, mission "add two tables and give them meaningful names, then say
what you did". Three runs per arm, same machine, same hour.

#520 replaced the one-shot Claude participant (`claude -p` per turn, no memory) with one
stream-json session per run, on an n=1 comparison from the issue: 188 actions over 90 turns and
no finish, against 21 actions over 8 turns. MemTrapBench (Zhejiang, 2026-08) reports memory
frameworks degrading agent performance by 10 to 40% on some tasks. So the claim had to be measured
on a lab, with the trace saying which path ran. `HUMANISH_LOCAL_AGENT_ONE_SHOT=1` selects the
cold-start path for that purpose.

## First, the one-shot path was broken

All three one-shot runs failed on turn one: `Claude Code exited 1: Error: Input must be provided
either through stdin or as a prompt argument when using --print`. `--allowedTools` takes a list,
so the prompt placed after it was read as a tool name. Claude Code 2.1.257 on this machine. The
session path sends the prompt on stdin and never hit it, so the shipped default (0.67.0 onward)
worked while the older path had been failing silently for anyone still on it. Fixed by `--`
before the prompt; the same command answers with `--` and fails without it.

## Then, the comparison

| arm | run | turns | actions | material | wall clock | outcome |
|---|---|---:|---:|---:|---:|---|
| session | `cua-2026-09-01T21-10-06-145Z-9e1ae82c` | 9 | 20 | 14 | 167 s | reached |
| session | `cua-2026-09-01T21-10-46-127Z-895387db` | 9 | 20 | 14 | 167 s | reached |
| session | `cua-2026-09-01T21-11-26-135Z-e4bf584a` | 9 | 20 | 14 | 168 s | reached |
| one-shot | `cua-2026-09-01T21-15-54-871Z-c9300621` | 9 | 17 | 13 | 252 s | reached |
| one-shot | `cua-2026-09-01T21-16-14-808Z-c1582c5f` | 9 | 18 | 13 | 247 s | reached |
| one-shot | `cua-2026-09-01T21-16-34-813Z-f4da6161` | 9 | 17 | 13 | 243 s | reached |

Six of six reached the goal and declared it (`REACHED THE GOAL.`). Nine turns in every run. The
one-shot arm spent about 80 s more per run, which is six cold `claude -p` boots at roughly 13 s
each, and three or four fewer recorded actions. Every participant reported the same two drawDB
frictions (random table names, stacked placement).

## What this says

- On a mission this short, memory across turns changes the transport cost and nothing about the
  study: same turn count, same outcome, same findings. The 188-versus-21 figure in #520 came from
  a longer mission with a menu to re-try; it is still that mission's n=1.
- The session path stays the default. The one-shot path is a measurement switch, now working, and
  the trace's `ids.model` says which ran ("one session per run" or not).

## Not verified

The harder mission. A lab where a participant has to recover from a wrong turn is where memory
should matter, and this receipt does not measure one.
