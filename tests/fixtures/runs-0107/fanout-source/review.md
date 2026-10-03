# Fan-out proof

- run: fanout-source
- mode: live
- run gate: fail
- summary: Run gate: fail. Participants: 3/3 reported reaching the goal. Recorded summary: Computer-use fan-out (4 participants, one world each): 3/4 participant(s) reached a terminal, engaged verdict: 3/3 reported reaching the goal.
- actor: openai-responses-cu (computer-use/cua-loop)
- evidence: 4 trace item(s), 2 raw screenshot(s)

## Gaps
- desktop-power: transient actor transport failed
- Participant reports alone do not establish task success. A matched stop condition establishes only its declared condition. Run gate and share-safety results are separate.
