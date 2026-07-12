# Core Contract

Date: 2026-06-02

Status: v0 draft contract with tested primitive helpers in `src/core`.

## Purpose

Core is the reusable layer that makes a run bundle stable enough for agents,
reviewers, and maintainers to trust. It owns generic run identity, artifact
layout, source state summaries, lifecycle records, latest/history pointers, and
timing summaries.

Core does not own product routes, personas, scenarios, app topology, provider
setup, or repository-specific proof language.

## Public-Safe Defaults

Core records must be safe to include in public run bundles by default:

- artifact paths are relative;
- run ids contain only lowercase letters, numbers, and dashes;
- git state summarizes status without branch names, remotes, file names, file
  paths, or absolute working directories;
- lifecycle and timing records are explicit inputs, not inferred prose;
- latest/history pointers identify local artifacts, not hosted private logs.

## Primitive Set

| Primitive | Contract |
| --- | --- |
| Run id | Deterministic from explicit prefix, timestamp, and entropy; valid ids match `^[a-z0-9][a-z0-9-]{0,127}$`. |
| Artifact layout | Builds stable relative pointers under `.humanish/runs/<run-id>/` plus `.humanish/runs/latest.json`. |
| Latest pointer | `{ schema, runId, path, updatedAt }` using `humanish.latest-run.v1`. |
| History entry | `{ schema, runId, createdAt, mode, path }` using `humanish.run-history-entry.v1`. |
| Lifecycle event | `{ at, event, message }`; event and message are required. |
| Timing summary | `{ startedAt, endedAt, durationMs, status }`; running records have null end and duration. |
| Git state | `{ schema, status, capturedAt, head, changes, note }` using `humanish.git-state.v1`. |

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
  credential-like value;
- a run id cannot be reproduced from explicit inputs.
