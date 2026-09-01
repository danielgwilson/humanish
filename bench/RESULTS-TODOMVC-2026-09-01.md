# Detection benchmark, real third-party app

**2026-09-01, humanish 0.64.0, `openai-computer-use` on hosted E2B desktops, N=3.**

Subject: TodoMVC's `javascript-es6` example at `tastejs/todomvc@ff43b02`, served from its committed
`dist/` so no build step of ours sits between the persona and what the repository ships. We planted
nothing. There is no answer key and no recall number here.

The Taskly arms measured recall against defects we wrote into an app we wrote. This arm removes
that control and asks the question an adopter actually has: **when a persona reports something
about software we did not write, is it true?**

## Findings, and whether they survive a hand check

Every confirmed row was checked against `dist/app.css` and `dist/app.bundle.js` after the runs.

| # | what the persona reported | runs | verdict | evidence |
|---|---------------------------|:----:|---------|----------|
| 1 | new items appear at the top, so the list ends up in reverse entry order | 3/3 | **confirmed** | the view renders `e.reverse().forEach(...)` in `app.bundle.js` |
| 2 | long text wraps mid-word ("office" split so a lone "e" sits on the next line) | 3/3 | **confirmed** | `word-break:break-all` in `app.css` |
| 3 | the delete X overlaps the task text instead of having reserved space | 2/3 | **confirmed** | `.destroy` is `position:absolute; right:10px; width:40px`, while the label has only `padding-right:15px` |
| 4 | the delete X is invisible until hover, so removal is not discoverable | 2/3 | **confirmed** | `.destroy{display:none}` with `li:hover .destroy{display:block}` |
| 5 | in the Completed view the footer still said "2 items left" | 1/3 | **confirmed** | the count is TodoMVC's active-item count and does not follow the filter |
| 6 | the first click on Active felt laggy; the completed item stayed visible briefly | 1/3 | **unverified** | subjective timing, reported once, not reproducible from source |

**5 of 6 confirmed. 0 false reports.**

The one unverified item is a perception of latency, reported once and hedged in the persona's own
words ("it updated shortly afterward"). It is not a claim that source can settle either way.

## What is worth noting about the confirmed set

Every confirmed finding is traceable to a specific declaration, which is what makes them
actionable. Finding 3 in particular is a real interaction defect that
only appears when a task is long enough to wrap: the persona hit it because it was told to add "one
long enough to describe something properly", and it described the overlap it saw, in those terms.

Finding 5 shows the persona reasoning correctly rather than reporting confusion as a bug: it wrote
that it "worked out that it meant two unfinished items overall, but that initially seemed
inconsistent." That is a usability observation about a real design decision, correctly framed.

## What this arm does and does not establish

It establishes that on a real third-party app, during ordinary use, the reports hold up: five of
six checked out against source and none was invented. Confident invention is the failure mode
synthetic-user tooling is most criticised for, and this is a measurement against it rather than an
assurance about it.

It does not establish recall on real software. Nobody knows the full defect set of TodoMVC, so
there is no denominator. Recall needs planted defects, and planted defects need an app we control,
which is what `bench/RESULTS-2026-09-01.md` covers and why its number is an upper bound.

Read the two arms together: recall 15 of 15 where we knew the answers, and 5 of 6 confirmed with
nothing invented where we did not.
