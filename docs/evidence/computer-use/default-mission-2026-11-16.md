# The default mission on a work tool and on a leisure app, 2026-11-16

The question: when a study names no mission, does the built-in one keep a participant using the app
the way a first-time user would, on a tool people use for work and on an app people open for fun?

Humanish 0.160.0 (08d26adf3), `gpt-6.1-sol` at medium effort, `actor.type: computer-use` on E2B
desktops. Each candidate ran as the study's `mission:`, which takes the same place in the prompt as
the built-in mission.

## Result

- The 0.160.0 default asks for a decision: "until you have decided whether you would keep using it,
  then stop". On Taskly that keeps a participant going: 4 of 4 tried a filter and reported the
  planted filter defect. On a game played in rounds it ends the session early: 24 participants
  played 1.0 round on average, stayed 1.2 minutes, and none finished a game.
- A mission with no decision clause does the opposite. In three such wordings 32 of 33 counted
  game sessions finished a full game, and on Taskly participants added two or three errands and
  stopped: 0 of 4 tried a filter in two of the three wordings and 1 of 4 in the third.
- The new default names both ends of a first sitting, "long enough to get what you came for and to
  know whether you would come back". On Taskly 4 of 4 tried a filter and reported the planted
  filter defect. On the game 12 of 12 finished a five-round game.

The new default:

> You are trying a web app for the first time, on your own device and in your own time. The browser is already open at it. Use it the way you actually would, for a real first sitting: long enough to get what you came for and to know whether you would come back. Then stop. Stop sooner if you would give up.

## The wordings

Every wording keeps "The browser is already open at it." and ends with "Stop sooner if you would
give up." or the same words after "or".

| Arm | The part that differs |
| --- | --- |
| 0.160.0 | "You are trying a web app for the first time. … Use it the way you actually would, until you have decided whether you would keep using it, then stop." |
| A | "You are on your own device in your own time, and you have opened this web app for the first time because you wanted to use it. … Use it the way you actually would, for as long as you actually would, and stop when you would normally close it." |
| B | "You have opened this web app for the first time, on your own device, because you want what it offers. … Put it to real use for something of your own, the way you actually would, and keep going for as long as it is worth your while." |
| C | "You are trying a web app for the first time, on your own device and in your own time. … Use it for something of your own, the way you actually would, for as long as you would in a first sitting with an app like this." |
| D | "… Use it the way you actually would, for as long as it keeps being useful or enjoyable, and at least until you have decided whether you would keep using it. Then stop." |
| E, the new default | "… Use it the way you actually would, for a real first sitting: long enough to get what you came for and to know whether you would come back. Then stop." |
| F | The 0.160.0 wording, then "If you would keep using it, carry on for as long as you normally would in one sitting, then stop." |

A, B and C were written first. D, E and F were written after A stopped at two errands in 4 of 4
Taskly runs, and each keeps a decision clause.

## Taskly, planted build

The method of the [2026-10-26 page](persona-adherence-2026-10-26.md): the benchmark project's
planted build and its non-technical persona (`bench/personas/occasional-computer-user.yaml`), one
participant per run, four runs per arm, tasks kept in memory. "Tried a filter" and the defect
columns are read from the closing reports by hand.

| Arm | Turns, median | Tried a filter | Planted filter defect reported | Dead Save reported | Reports describing placeholder data |
| --- | --- | --- | --- | --- | --- |
| 0.160.0 | 7 | 4 of 4 | 4 of 4 | 0 | 1 ("two sample errands") |
| A | 4.5 | 0 of 4 | 0 | 0 | 0 |
| B | 6.5 | 1 of 4 | 1 of 4 | 2 of 4 | 0 |
| C | 6 | 0 of 4 | 0 | 0 | 0 |
| D | 8 | 4 of 4 | 4 of 4 | 0 | 0 |
| E, the new default | 8 | 4 of 4 | 4 of 4 | 1 of 4 | 0 |
| F | 7 | 2 of 4 | 2 of 4 | 0 | 4 ("three sample errands") |

All 28 reports mention the `undefined` empty state. B's "put it to real use for something of your
own" led two participants to add a detail to an errand, which is how they met the dead Save.

## A game played in rounds

A public web game where a game is five rounds. Twelve participants per arm with no persona, each on
its own desktop; the 0.160.0 arm is a 24-participant run from 2026-11-15. Counts come from the
game's own analytics, and a session is counted when it started a round. Arms A and B count fewer
sessions than participants: two of A's and one of B's did not appear in the analytics with a
started round, and what they did is not counted here.

| Arm | Sessions counted | Rounds played, mean | Finished a five-round game | Minutes, mean |
| --- | --- | --- | --- | --- |
| 0.160.0 | 24 | 1.0 | 0 of 24 | 1.2 |
| A | 10 | 5.0 | 10 of 10 | 3.8 |
| B | 11 | 4.8 | 10 of 11 | 4.4 |
| C | 12 | 5.0 | 12 of 12 | 4.3 |
| D | 12 | 4.3 | 9 of 12 | 3.7 |
| E, the new default | 12 | 5.0 | 12 of 12 | 4.1 |

F was not run on the game. No participant in any arm started a second game. Real first sessions on
that game are longer than every arm's, and no wording closed that gap.

## Runs

Taskly run ids, all `cua-2026-11-16T…`:

| Arm | Runs |
| --- | --- |
| 0.160.0 | `00-40-47-525Z-1063e6f8`, `00-42-08-252Z-04e5ca8d`, `00-43-22-953Z-4ed8e100`, `00-44-43-074Z-56b12670` |
| A | `00-40-48-610Z-8cf9439a`, `00-41-54-488Z-8022b775`, `00-43-07-274Z-4199bd62`, `00-44-28-630Z-f28b9eee` |
| B | `00-40-49-727Z-6fa675b3`, `00-42-01-590Z-c9ac550f`, `00-43-29-321Z-8a321dc4`, `00-45-04-908Z-f4104c39` |
| C | `00-40-50-783Z-8e4780ba`, `00-42-05-502Z-068662ef`, `00-43-22-088Z-c1bb3e03`, `00-44-39-842Z-9de04a78` |
| D | `00-46-07-194Z-43abc2a5`, `00-47-36-743Z-a449ec82`, `00-48-58-302Z-44599305`, `00-50-19-214Z-c3a49639` |
| E | `00-46-08-134Z-0fd7118a`, `00-47-33-428Z-81fcb34c`, `00-48-57-236Z-cc81c8dc`, `00-50-21-232Z-a5aa9b0f` |
| F | `00-46-09-089Z-137149e2`, `00-47-24-011Z-bc21e308`, `00-48-49-356Z-6e215ea7`, `00-50-34-138Z-db3fc3ef` |

The bundles are kept by the maintainer and are not in the repository. Estimated spend $22.74:
$1.23 on Taskly and $21.51 on the game.

## Not verified

- One model. No Anthropic or Gemini participant ran these wordings.
- One persona on Taskly and none on the game.
- Four runs per arm on Taskly and twelve participants per arm on the game.
- The clean Taskly build, so no count of invented defects under the new wording.
- A second work tool, a second leisure app, and phone participants.
- The new default together with a paragraph on typing, a separate change that was not part of
  these runs.
