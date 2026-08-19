// Synthetic `.humanish/runs` trees for tests (#455 PR 2).
//
// Why synthetic rather than copied from a real project: real run directories carry lab ids naming
// the operator's own work, real costs, and real participant text. Every committed expectation about
// listing and rendering must therefore come from fixtures written here, so a test can never leak a
// private project name into the repository.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RUN_STATUS_FILE, RUN_STATUS_SCHEMA } from "../../src/run-status.js";

export interface FixtureRunSpec {
  runId: string;
  /** Omit for a run with no lab attribution (a library caller, or a pre-contract run). */
  labId?: string;
  labPath?: string;
  labOrigin?: "committed" | "ignored" | "explicit";
  mode?: "dry-run" | "live";
  /**
   * `running` writes a fresh record; `stale` writes a `running` record whose updatedAt is old
   * (an interrupted run: the process died without finalizing); `finished` writes a final record.
   * `legacy-bundle` writes only a run.json with the old `lab:<id>` convention and no record;
   * `orphan` writes neither — receipts on disk and nothing else.
   */
  state: "running" | "stale" | "finished" | "legacy-bundle" | "orphan";
  startedAt?: string;
  /** Only used by `finished`: how long the run took. */
  durationMs?: number;
  verdict?: string;
  participants?: { total: number; reachedGoal: number; reportedFriction?: number };
  /** `null` writes a declared-absent cost (the honest unknown), `undefined` omits it entirely. */
  estimatedCostUsd?: number | null;
  /** Reasoning-summary text for a live run, as a provider would emit it (markdown lead included). */
  thought?: string;
}

const DEFAULT_START = "2026-08-19T10:00:00.000Z";

/** Write one synthetic run tree. Returns the run directory. */
export async function writeFixtureRun(cwd: string, spec: FixtureRunSpec, nowMs = Date.parse("2026-08-19T10:05:00.000Z")): Promise<string> {
  const runDir = path.join(cwd, ".humanish", "runs", spec.runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = spec.startedAt ?? DEFAULT_START;

  if (spec.state === "orphan") {
    // Receipts without an outcome: exactly what a dropped connection leaves behind.
    await writeFile(path.join(runDir, "sandbox-receipts.ndjson"), `${JSON.stringify({ kind: "created" })}\n`, "utf8");
    return runDir;
  }

  if (spec.state === "legacy-bundle") {
    await writeFile(
      path.join(runDir, "run.json"),
      `${JSON.stringify(legacyBundle(spec, startedAt), null, 2)}\n`,
      "utf8"
    );
    return runDir;
  }

  const finished = spec.state === "finished";
  const updatedAt = finished
    ? new Date(Date.parse(startedAt) + (spec.durationMs ?? 60_000)).toISOString()
    : spec.state === "running"
      ? new Date(nowMs - 1_000).toISOString()
      : new Date(nowMs - 600_000).toISOString();

  const record = {
    schema: RUN_STATUS_SCHEMA,
    runId: spec.runId,
    state: finished ? "finished" : "running",
    mode: spec.mode ?? "live",
    ...(spec.labId === undefined
      ? {}
      : {
          lab: {
            id: spec.labId,
            ...(spec.labPath === undefined ? {} : { path: spec.labPath }),
            ...(spec.labOrigin === undefined ? {} : { origin: spec.labOrigin })
          }
        }),
    pid: 4242,
    startedAt,
    updatedAt,
    ...(finished
      ? {
          completedAt: updatedAt,
          outcome: {
            ...(spec.verdict === undefined ? {} : { verdict: spec.verdict }),
            ...(spec.participants === undefined ? {} : { participants: spec.participants }),
            ...(spec.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: spec.estimatedCostUsd })
          }
        }
      : {})
  };
  await writeFile(path.join(runDir, RUN_STATUS_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  if (finished) {
    await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(legacyBundle(spec, startedAt), null, 2)}\n`, "utf8");
  } else if (spec.thought !== undefined) {
    // A live run's in-progress bundle carries the liveActor partial the surfaces read.
    await writeFile(
      path.join(runDir, "run.json"),
      `${JSON.stringify(
        {
          schema: "humanish.run-bundle.v1",
          runId: spec.runId,
          streams: [
            {
              id: "stream-001",
              liveActor: {
                schema: "humanish.live-actor.v1",
                updatedAt,
                items: [{ id: "reasoning-001", kind: "reasoning", lifecycle: "completed", title: "reasoning turn 1", text: spec.thought }]
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
  return runDir;
}

function legacyBundle(spec: FixtureRunSpec, startedAt: string): Record<string, unknown> {
  return {
    schema: "humanish.run-bundle.v1",
    runId: spec.runId,
    mode: spec.mode ?? "live",
    createdAt: startedAt,
    // The pre-contract attribution convention, so the legacy bridge has something real to read.
    persona: { source: spec.labId === undefined ? "humanish/personas/synthetic-new-user.yaml" : `lab:${spec.labId}` },
    review: {
      verdict: spec.verdict ?? "pass",
      ...(spec.participants === undefined ? {} : { participants: spec.participants })
    },
    ...(spec.estimatedCostUsd === undefined ? {} : { cost: { estimatedTotalUsd: spec.estimatedCostUsd } })
  };
}

/** Write a whole project's worth of runs in one call. */
export async function writeFixtureRuns(cwd: string, specs: readonly FixtureRunSpec[], nowMs?: number): Promise<void> {
  for (const spec of specs) {
    await writeFixtureRun(cwd, spec, nowMs);
  }
}
