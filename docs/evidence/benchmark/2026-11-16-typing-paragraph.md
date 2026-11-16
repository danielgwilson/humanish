# The typing paragraph on the Taskly benchmark, 2026-11-16

The question: does a paragraph that tells participants to type as people do change which planted
defects they report?

`pnpm bench --mission neutral --runs 6 --no-analysis`, `gpt-6.1-sol` at medium effort, the
`synthetic-new-user` persona, one participant per run on its own E2B desktop. Three builds:
humanish 0.160.0, which has no paragraph; `main` at bc4b5fe2b, with the first wording; and the
narrowed wording that ships. The first two ran twice.

## Result

- The first wording covered "a message, a search, a form answer". Participants then wrote shorter
  task names: a participant wrote an entry over 30 characters in 3 of 24 runs, against 20 of 24 on
  0.160.0. The truncation defect needs such an entry, and its reports went from 6 of 12 to 0 of 12.
- The first wording also shortened the participant's own closing report, from a median of 171
  words to 144. Dead Save was reported in 3 of 12 runs against 6 of 12, though every participant
  used the control in both.
- The narrowed wording names a chat and a search box in the app and says anything else is as long
  as the person would make it. Recall is back to 18 of 30, against 36 of 60 on 0.160.0, the
  truncation defect is reported in 3 of 6 runs, and the closing report is 160 words.
- No build invented a defect on the clean arm.
- In support-chat tasks the narrowed wording keeps the gain of the first: 13.0 words a turn in
  both, against about 30 with no paragraph.

The wording that ships:

> When you type into a chat or a search box in the app, type as this person would at their own keyboard when nobody is grading them. People type little there: a few plain words, often without a greeting or a thank-you, one thing at a time, and only as much of a search as it takes for the result to show up. Anything else you write in the app (a task, a note, a post, an answer on a form) is as long as this person would really make it.

## Participant reports, planted build

| | 0.160.0, 12 runs | First wording, 12 runs | Narrowed wording, 6 runs |
| --- | --- | --- | --- |
| D1 Clear completed does nothing | 0 | 0 | 0 |
| D2 Text over 30 characters is truncated on add | 6 | 0 | 3 |
| D3 Active and Completed filters are swapped | 12 | 12 | 6 |
| D4 Empty list renders the literal text undefined | 12 | 12 | 6 |
| D5 Save in edit mode does nothing | 6 | 3 | 3 |
| Recall, all defects | 36 of 60 | 27 of 60 | 18 of 30 |
| Runs that wrote an entry over 30 characters | 9 | 1 | 5 |
| Invented defects, clean arm | 0 in 12 runs | 0 in 12 runs | 0 in 6 runs |

Scores are the benchmark rubric's, version 5, on the closing reports. No analysis ran.

## What participants wrote, planted and clean runs together

| | 0.160.0, 24 runs | First wording, 24 runs | Narrowed wording, 12 runs |
| --- | --- | --- | --- |
| Typed entry, median characters | 24 | 18 | 21 |
| Runs with an entry over 30 characters | 20 | 3 | 9 |
| Closing report, median words | 171 | 144 | 160 |
| Turns, median | 11 | 11.5 | 11 |

Entry lengths come from each trace's action log, which records how many characters were typed and
never the text.

## Support chat, the same tasks

One participant per task plays a customer in a support chat. The measures are per participant
turn.

| | No paragraph, 30 tasks, two runs | First wording, 30 tasks | Narrowed wording, 10 tasks |
| --- | --- | --- | --- |
| Words | 30.7 and 28.9 | 12.8 | 13.0 |
| Turns with a courtesy phrase | 55% and 54% | 11% | 7% |
| Turns of three words or fewer | 2% and 1% | 20% | 19% |
| Words in the opening message | 41 and 40 | 19 | 17 |
| Tasks the chat got done | 60% and 53% | 57% | 6 of 10 |

## The built-in mission

`pnpm bench --mission default --runs 3 --no-analysis`, where the generated studies carry no
mission: 6 of 15 on 0.160.0 and 7 of 15 on `main` at bc4b5fe2b, with the swapped filters and the
empty state reported in 3 of 3 runs on both. Neither invented a defect on the clean arm. No
participant on either build wrote an entry over 30 characters under this mission.

## Runs

Run ids are `cua-2026-11-16T…`; each set ran planted and clean alternately.

| Set | First run | Last run |
| --- | --- | --- |
| 0.160.0, neutral, first set | `03-32-17-966Z-d4e66955` | `03-48-40-724Z-e2a0b81d` |
| 0.160.0, neutral, second set | `04-04-39-803Z-7a2d7a51` | `04-21-14-563Z-9a1fa397` |
| First wording, neutral, first set | `03-47-07-227Z-940ac072` | `04-02-41-562Z-0bb0fe4a` |
| First wording, neutral, second set | `04-05-02-236Z-70790d1e` | `04-21-23-836Z-84f371b1` |
| Narrowed wording, neutral | `04-25-06-289Z-b716b283` | `04-41-27-142Z-c3865547` |
| 0.160.0, built-in mission | `03-54-23-896Z-b992e0bd` | `04-00-18-156Z-a058ec80` |
| First wording, built-in mission | `03-47-34-493Z-2f35d6fa` | `03-53-00-115Z-994b8018` |

The bundles are kept by the maintainer and are not in the repository. Estimated spend $5.69 on
Taskly and $2.40 on the narrowed wording's chat run.

## Not verified

- The narrowed wording ran one Taskly set of 6 and 10 chat tasks. The first wording ran two sets
  and 30 tasks.
- One model on Taskly. The first wording also ran on `claude-haiku-5-5` in chat; the narrowed one
  did not.
- The analysis step. These runs score participant reports only.
- Whether entries of 21 to 24 characters, or 18, are closer to what people write in a to-do list.
  No reference of real entries was used.
- The narrowed wording under the built-in mission.
