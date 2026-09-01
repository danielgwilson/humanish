# Detection benchmark, second real third-party app: drawDB, eleven participants

**2026-09-01, humanish 0.65.0 to 0.67.0, three brains, N=11 participants across five studies.**

Subject: `drawdb-io/drawdb@5efc5fd10a27241f0844dfd31efff4a9e53a61fb`, cloned, built, and served
in-sandbox by the `try-live` starter lab and the `persona-contrast-demo` lab. We planted nothing
and wrote none of it. As with the TodoMVC arm, there is no answer key and no recall number; the
question is whether what the participants reported is true.

This arm cost nothing extra: the eleven reports are the ones the day's other studies produced
(three provider-key cold installs, two keyless codex runs, two Claude-session runs, and the four
lanes of two persona-contrast runs). The mission was "add two tables and give them meaningful
names, then say what confused you" or "create a two-table diagram with a relationship"; no report
was asked for defects.

## Every distinct claim, and whether it survives a source check

Checked against the repository at that commit after the runs.

| # | what participants reported | how many of 11 | verdict | evidence in the source |
|---|---|:--:|---|---|
| 1 | a new table gets a long random name instead of a prompt or `table_1` | 9 | **confirmed** | `addTable` sets `name: \`table_${id}\`` with `id = nanoid()` (`src/context/DiagramContext.jsx`) |
| 2 | every new table lands at the same canvas position, on top of the last | 6 | **confirmed** | `x: transform.pan.x, y: transform.pan.y`, the pan origin, for every new table (same file) |
| 3 | a mandatory "Choose a database" modal appears before anything is drawn; a "Generic" option exists | 5 | **confirmed** | `Workspace.jsx` opens the modal when `selectedDb === ""`; `pick_db`, `generic` in `en.js` |
| 4 | renaming happens in the sidebar `Name` field, reached by expanding the row or double-clicking the canvas card | 7 | **confirmed** | `Table.jsx` `onDoubleClick={openEditor}`; `TableInfo.jsx` holds the name input |
| 5 | the name updates live as typed, no Enter or Save | 3 | **confirmed** | `TableInfo.jsx` `onChange={(value) => updateTable(data.id, { name: value })}` |
| 6 | expanding one table's row collapses the other and shifts the layout under the cursor | 2 | **confirmed** | `TablesTab.jsx` renders `<Collapse accordion>` |
| 7 | the canvas truncates the long name | 3 | **confirmed** | `Table.jsx` header `overflow-hidden text-ellipsis whitespace-nowrap` |
| 8 | the database modal is not keyboard accessible: Tab skips the options, Confirm stays disabled, Esc does nothing | 2 (both keyboard-first; a third keyboard-first participant in a later run reported it too) | **confirmed** | options are `<div onClick>` with no `tabIndex`, `role`, or key handler; `okButtonProps={{ disabled: selectedDb === "" }}`; `closable={false}` `hasCancel={false}` |
| 9 | each new table comes with a default `id` primary-key field | 3 | **confirmed** | `fields: [{ name: "id", primary: true, ... }]` in `addTable` |
| 10 | an Auto arrange tool resolves the overlap | 2 | **confirmed** | `src/utils/autoArrange.js` |
| 11 | the landing page's "Try it for yourself" opens the editor | 4 | **confirmed** | `LandingPage.jsx` line 96 |
| 12 | the "Last saved" stamp read older than the last rename | 1 | **unverified** | `setLastSaved` runs on autosave; whether one rename sat outside an autosave tick is timing, not source |

**11 of 12 confirmed. 0 false reports.** The one unverified claim is a timing observation from one
participant, the same class as the TodoMVC arm's one unverified row.

## Read next to the other arms

| arm | app | wrote it? | participants | confirmed | invented |
|---|---|---|---:|---|---|
| Taskly clean (0.63.0) | ours | yes | 3 | 3 of 3 true findings | 0 |
| Taskly clean (0.66.0) | ours | yes | 3 | 3 of 3 true findings | 0 |
| TodoMVC (0.64.0) | third party | no | 3 | 5 of 6 | 0 |
| drawDB (0.65.0 to 0.67.0) | third party | no | 11 | 11 of 12 | 0 |

Twenty participants on apps we did not write, 0 invented defects. Row 8 is the finding a mouse-only
study would have missed; `docs/goals/computer-use-actor/receipts/persona-contrast-live-2026-09-01.md`
has the two runs.

## Runs

`cua-2026-09-01T18-51-13-111Z-6dc85b53`, `cua-2026-09-01T18-51-32-117Z-97d3ecee`,
`cua-2026-09-01T18-51-52-180Z-b1a6ce31` (provider key), `cua-2026-09-01T19-13-27-106Z-5723d5e8`,
`cua-2026-09-01T19-13-46-616Z-faffe4db` (keyless codex), `cua-2026-09-01T19-18-18-747Z-02a18f68`,
`cua-2026-09-01T19-18-32-221Z-cf40bddb` (Claude session), `cua-2026-09-01T19-35-50-833Z-f390a70a`,
`cua-2026-09-01T19-36-20-743Z-d133dcea` (persona contrast, two lanes each).
