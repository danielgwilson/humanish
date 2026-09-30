# Core Contract

Date: 2026-06-02 (current-state note updated 2026-09-30)

Status: there is no shared core module. Each route builds its run id, writes
its bundle and moves the latest pointer itself. `src/run/paths.ts` holds the
shared path rules and `src/run/git-state.ts` captures git state. The table
below lists the records current bundles write.

## Purpose

Core is the reusable layer that makes a run bundle stable enough for agents,
reviewers, and maintainers to trust. It covers generic run identity, artifact
layout, source state summaries, lifecycle records and the latest pointer.

Core does not own product routes, personas, scenarios, app topology, provider
setup, or repository-specific proof language.

## Public-Safe Defaults

Core records must be safe to include in public run bundles by default:

- artifact paths are relative;
- route-built run ids join a route prefix, the ISO creation time with `:` and
  `.` replaced by `-`, and random hex; runtime readers accept any id that is a
  safe single path segment;
- git state summarizes status without branch names, remotes, file names, file
  paths, or absolute working directories;
- lifecycle records are explicit inputs, not inferred prose;
- the latest pointer identifies local artifacts, not hosted private logs.

## Primitive Set

| Primitive       | Contract                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run id          | Routes build `<prefix>-<timestamp>-<hex>` ids, for example `cua-2026-06-02T10-00-00-000Z-1a2b3c4d`. Runtime artifact binding uses the compatibility rule in `src/run/paths.ts`: one non-empty segment, excluding `.`, `..`, separators, and NUL. `latest.json` is reserved. |
| Artifact layout | Run bundles live under `.humanish/runs/<run-id>/`, and the latest pointer is `.humanish/runs/latest.json`.                                                                                                                                                                  |
| Latest pointer  | `{ schema, runId, path, updatedAt }` using `humanish.latest-run.v1`.                                                                                                                                                                                                        |
| Lifecycle event | `{ at, event, message }` entries in `run.json` `lifecycle[]`; event and message are required.                                                                                                                                                                               |
| Git state       | `{ schema, status, capturedAt, head, changes, note }` using `humanish.git-state.v1`, captured by `src/run/git-state.ts`.                                                                                                                                                    |

## Git State Boundary

Git state is intentionally lossy. It answers:

- is this a work tree?
- is it clean or dirty?
- what short HEAD hash is available?
- is HEAD attached, detached, unborn, or unknown?
- how many staged, unstaged, and untracked entries exist?

It does not record:

- branch names;
- remotes;
- file names;
- file paths;
- absolute directories;
- diffs;
- commit messages.

That makes it useful for repeatability and review without turning run bundles
into a source leak.

## Stop Conditions

Core work stops if:

- a core primitive needs a product-specific noun to make sense;
- an artifact path can escape the run root;
- a public record includes a raw cwd, branch name, remote, file name, diff, or
  credential-like value.
