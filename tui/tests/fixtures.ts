// Deterministic data for the text goldens (#455).
//
// Synthetic by construction, and for the same reason the run fixtures in the root suite are: real
// projects carry lab ids naming the operator's own work, real costs and real participant text, and
// a golden built from one would commit that to a public repo. These names are invented, the numbers
// are round, and the clock is frozen — so a golden that changes means the UI changed.

import type { LabListEntry } from "../../src/labs.js";
import type { RunIndexEntry } from "../../src/run-index.js";

export const NOW = Date.parse("2026-08-19T12:00:00.000Z");

const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

export const LABS: LabListEntry[] = [
  {
    id: "signup-flow",
    source: "app-url",
    origin: "committed",
    path: "humanish/labs/signup-flow.yaml",
    title: "Signup flow",
    // Two sentences on purpose: the list shows the FIRST one, because a paragraph in a status bar
    // is a paragraph nobody reads.
    description: "Can a first-time visitor finish signing up unaided? Committed as dry-run."
  },
  { id: "diagram-editor", source: "app-url", origin: "committed", path: "humanish/labs/diagram-editor.yaml", title: "Is the diagram axis load-bearing?" },
  { id: "never-run-lab", source: "app-url", origin: "ignored", path: ".humanish/labs/never-run-lab.yaml" },
  // Two manifests declaring ONE id. Not hypothetical: this repo's own project has exactly this
  // pair, and it is what proved that keying rows by lab id renders indistinguishable duplicates.
  // The FILENAMES differ, which is what lab resolution actually addresses.
  // ...and it shares the TITLE too, which is what the real pair does. A fixture where only the id
  // collided passed happily while the real project still rendered two identical rows.
  { id: "diagram-editor", source: "app-url", origin: "ignored", path: ".humanish/labs/diagram-editor-live.yaml", title: "Is the diagram axis load-bearing?" }
];

export const RUNS: RunIndexEntry[] = [
  {
    runId: "cua-2026-08-19T11-30-00-000Z-aa11bb22",
    derivedFrom: "status",
    liveness: "running",
    mode: "live",
    lab: { id: "signup-flow" },
    startedAt: at(30),
    updatedAt: at(0)
  },
  {
    runId: "cua-2026-08-19T10-00-00-000Z-cc33dd44",
    derivedFrom: "status",
    liveness: "finished",
    mode: "live",
    lab: { id: "signup-flow" },
    startedAt: at(120),
    completedAt: at(118),
    verdict: "pass",
    participants: { total: 2, reachedGoal: 2, reportedFriction: 1 },
    estimatedCostUsd: 1.2,
    durationMs: 120_000
  },
  {
    runId: "cua-2026-08-18T09-00-00-000Z-ee55ff66",
    derivedFrom: "bundle",
    liveness: "finished",
    mode: "live",
    lab: { id: "diagram-editor" },
    startedAt: at(1_500),
    completedAt: at(1_496),
    verdict: "fail",
    participants: { total: 1, reachedGoal: 0 },
    // A declared-absent cost: excluded from the median AND counted, never rendered as $0.00.
    estimatedCostUsd: null,
    durationMs: 240_000
  },
  {
    runId: "cua-2026-08-18T08-00-00-000Z-99887766",
    derivedFrom: "directory",
    liveness: "interrupted",
    lab: { id: "diagram-editor" },
    startedAt: at(1_600)
  },
  {
    // No lab attribution at all: a library caller or a pre-contract run.
    runId: "run-2026-08-17T07-00-00-000Z-01020304",
    derivedFrom: "bundle",
    liveness: "finished",
    startedAt: at(3_000),
    completedAt: at(2_990),
    verdict: "pass"
  }
];
