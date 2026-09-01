# Taskly detection benchmark, third run: after the closing line

**2026-09-01, main at #579 (0.68.0 plus the fixed closing line), `openai-computer-use`, N=3 per arm,
$1.22.** Same labs, persona, and mission as the [first](RESULTS-2026-09-01.md) and
[second](RESULTS-2026-09-01-0.66.0.md) runs. This run exists because #579 changed every
computer-use prompt (it asks for a fixed first line), and a prompt change has to be checked
against the one instrument whose answers are known.

## Recall: 14 of 15

| defect | run 1 | run 2 | run 3 |
|---|:-:|:-:|:-:|
| D1 `Clear completed` does nothing | ✓ | **missed** | ✓ |
| D2 text over 30 chars silently truncated | ✓ | ✓ | ✓ |
| D3 `Active` and `Completed` filters swapped | ✓ | ✓ | ✓ |
| D4 empty list renders the literal text `undefined` | ✓ | ✓ | ✓ |
| D5 `Save` in edit mode does nothing; only Enter commits | ✓ | ✓ | ✓ |

Run 2 wrote "To tidy up, I used Clear completed and deleted the remaining tasks", which reads as
though it worked; scored as a miss. D1 is now the miss in two of three benchmark runs: a
participant that tidies up by deleting tasks one at a time never learns the button is dead, and
one that clicks it and then deletes anyway attributes the result to the wrong control.

Cumulative over three runs: **43 of 45**, Wilson 95% interval 0.85 to 0.99.

## Precision: no invented defects in 3 clean runs

No planted-defect class reported. Every clean run described the filters, Save, and Clear completed
working, in its own words ("The long text wrapped neatly and remained readable"). What they raised
is true of the app: Clear completed stays visible with nothing completed (1 of 3), Delete has no
undo (1 of 3), the `left` count under the Completed view (1 of 3). Twelve clean runs across three
benchmark runs, 0 invented.

## What the closing line did

| | second run (0.66.0) | this run (main at #579) |
|---|---|---|
| lanes refused as "not a credible pass" | 3 of 6 | **0 of 6** |
| lanes carrying `declaredOutcome` | 0 of 6 | **6 of 6** (`REACHED THE GOAL.`) |
| `reportedFriction` on the clean arm | 0 of 3 | 3 of 3 (#578 counts a hesitation) |

Recall and precision did not move. The prompt change changed the ending's label, not the findings.

## Runs

planted: `cua-2026-09-01T20-16-21-877Z-9ff3cf4a`, `cua-2026-09-01T20-16-41-865Z-dc7e8af1`, `cua-2026-09-01T20-17-01-877Z-2f659448` ($0.23, $0.22, $0.30); clean: `cua-2026-09-01T20-19-08-671Z-f4aa6a72`, `cua-2026-09-01T20-19-28-652Z-02364cbf`, `cua-2026-09-01T20-19-48-680Z-e2340c77` ($0.18, $0.14, $0.16).
