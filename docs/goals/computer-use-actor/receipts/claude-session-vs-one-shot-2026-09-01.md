# Does the Claude participant's memory across turns change the study? Not on try-live; yes on a harder mission

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

## The harder mission, same hour

The persona-contrast lab (two tables and a relationship, a keyboard-first lane and a mouse-driving
lane, 300 s per lane) with the Claude participant, two runs per arm:

| arm | run | lane | turns | actions | material | wall clock | outcome |
|---|---|---|---:|---:|---:|---:|---|
| session | `cua-2026-09-01T21-24-23-220Z-4ad4a357` | keyboard-first | 7 | 16 | 10 | 106 s | reached |
| session | `cua-2026-09-01T21-24-23-220Z-4ad4a357` | mouse newcomer | 18 | 45 | 34 | 212 s | reached |
| session | `cua-2026-09-01T21-25-12-037Z-19ca546f` | keyboard-first | 9 | 22 | 15 | 193 s | reached |
| session | `cua-2026-09-01T21-25-12-037Z-19ca546f` | mouse newcomer | 21 | 51 | 36 | 267 s | reached |
| oneshot | `cua-2026-09-01T21-24-47-037Z-169a60aa` | keyboard-first | 24 | 49 | 26 | 300 s | incomplete (budget) |
| oneshot | `cua-2026-09-01T21-24-47-037Z-169a60aa` | mouse newcomer | 14 | 33 | 22 | 300 s | incomplete (budget) |
| oneshot | `cua-2026-09-01T21-25-37-059Z-d0a11406` | keyboard-first | 21 | 43 | 23 | 300 s | incomplete (budget) |
| oneshot | `cua-2026-09-01T21-25-37-059Z-d0a11406` | mouse newcomer | 14 | 34 | 23 | 300 s | incomplete (budget) |

**Session 4 of 4 reached the goal; one-shot 0 of 4**, every one-shot lane ran out its 300 s
budget after 14 to 24 turns with 22 to 26 material actions, about as many as the session lanes
that finished. Two things are confounded in that: the cold boot (about 13 s per turn, so a
24-turn lane spends five of its minutes booting) and the absence of memory. Separating them
needs the one-shot arm on a longer budget, which this receipt does not run.

Both keyboard-first session participants avoided the mouse-only modal's worst case by typing the
`/editor` URL and switching to the DBML code view, which is a route the affordance record shows
(`url-navigation: 1`) and the mouse-driving newcomers never took.

## Not verified

Whether the one-shot arm would finish the harder mission on a longer budget; the 300 s cap does
not separate "no memory" from "13 s per turn to boot".
