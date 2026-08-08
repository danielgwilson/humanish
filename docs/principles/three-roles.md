# Three roles: researcher, stakeholder, participant

Humanish runs user research. Every design decision should be checked against the
three people a study actually involves, because they want different things and
conflating any two of them produces a specific, recurring class of bug.

## The roles

**The researcher** designs the study and runs it. In humanish this is usually an
agent invoking the CLI, not a person clicking. A researcher wants a protocol they
can express and defend: tasks with success criteria, a panel with declared
coverage, a pilot before the panel spends, and structured per-task outcomes back.
They care about rigor and control, and they need output they can reason over and
adjust.

**The stakeholder** watches. In a real study they sit behind the glass in the
viewing room; here they open Observer, `watch`, or `serve`. They want none of the
protocol. They want to know what happened, where people got stuck, how bad it is,
and whether anyone succeeded — moments, severity, and the denominator.

**The participant** is the persona. They have a goal, limited patience, and their
own idea of how the product works. They are the subject of the study, never its
instrument.

## Why the distinction earns its place

Two of humanish's worst bugs were category errors between these roles, not
missing features.

**Fusing the participant into the harness** made abandonment look like a
malfunction. `gave_up` mapped to a `failed` status, so a persona giving up — the
single most valuable thing a usability study produces — dragged the run verdict
red as though the instrument had broken. A participant abandoning a task is a
finding. The harness only fails when the harness fails.

**Fusing the researcher's question with the stakeholder's** put one pass/fail
verdict on a bundle that answers two different questions. "Is this evidence
trustworthy?" is genuinely pass/fail: did the harness do what it claimed, with a
real sandbox, real actions, and cost lines nobody forged. "What did we learn?" has
no pass/fail at all — asking whether a study passed is a category error. Because
there was one slot, a session that stopped early had to be called `passed`, and a
truncated study was reported as a green one.

## Checks worth applying

When adding a surface, a default, or a verdict, ask:

- **Which role is this for?** A knob that serves the researcher does not belong in
  the stakeholder's view, and a highlight reel is not evidence.
- **Is this a participant outcome or a harness outcome?** Abandonment, confusion,
  and running out of session are things that happened to a participant. Only a
  broken sandbox, a forged artifact, or an unreachable service is a harness
  failure.
- **Does the number travel with its denominator?** A stakeholder behind glass
  forms conclusions from vivid moments; that is the classic failure of the viewing
  room, and it is why researchers synthesize rather than letting the room decide.
  Anything shown to a stakeholder carries its count and its confidence, or it
  becomes a machine for manufacturing certainty from n=1.
- **Would a researcher recognize this as a study?** Budgets are recruiting
  decisions made once, up front — how many participants can we afford. No
  researcher has ever ended a session because it got expensive.

## Related

- [invariants-and-defaults.md](invariants-and-defaults.md) — fail-closed rules and
  what defaults are allowed to assume
- [actor-fidelity.md](actor-fidelity.md) — what a claim about persona realism can
  and cannot mean
