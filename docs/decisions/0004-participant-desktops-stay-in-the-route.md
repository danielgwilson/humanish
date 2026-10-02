# 0004: Participant desktops stay in the computer-use route

Accepted.

## Context

A participant runs on a `ParticipantDesktop`: the hosted E2B desktop, the local VM, or the
in-process executor. The structure review planned to move the interface to `src/substrates/`
beside the provider primitives. A later review graded the unmoved interface as a deviation from
that plan.

## Decision

The interface and its three implementations stay in `src/routes/computer-use/`. Each
implementation combines provider primitives from `src/substrates/` (the E2B sandbox, local VMs,
the `Shell`) with route concerns: subject provisioning, comms and the participant plan. Moving
only the interface to `src/substrates/` would split one concept across two folders, so
`src/substrates/` holds only the primitives.

## Consequences

- A reader finds the desktop contract and its implementations in one folder, beside the runner
  that calls them.
- `src/substrates/` stays free of route types; it does not import from `src/routes/`.
- Shared-world participants reach the same desktops through computer-use's `runCuaParticipant`
  (`src/routes/computer-use/participant-execution.ts`).

## Enforced by

- No check enforces the placement. The interface's doc comment in
  `src/routes/computer-use/participant-desktop.ts` states it, and the computer-use row of
  ARCHITECTURE.md's code map links here.
