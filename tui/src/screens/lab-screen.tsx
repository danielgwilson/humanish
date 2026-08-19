import { Box, Text } from "ink";
import React from "react";

import type { RunIndexEntry } from "../../../src/run-index.js";
import type { LabRow } from "../../../src/run-projection.js";
import { expectationLine, formatDuration, listWindow, livenessLabel } from "../../../src/run-projection.js";
import { color } from "../text-props.js";

export interface LabScreenProps {
  row: LabRow;
  runs: RunIndexEntry[];
  selected: number;
  columns: number;
  viewport: number;
  now: number;
}

/**
 * One lab: what it is, what to expect from it, and everything it has done.
 *
 * The expectation line sits directly under the name because it is what someone reads before
 * deciding to spend money — and it always carries its own denominator, so "~$2.00 median" can never
 * be mistaken for a quote when it came from two runs.
 */
export function LabScreen({ row, runs, selected, columns, viewport, now }: LabScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* The header carries the human name; this is the handle you would actually type. Lab
          resolution is by FILENAME, so this is the file stem and not necessarily the declared id. */}
      <Text dimColor>{row.declared ? `humanish lab run ${row.name}` : row.labId}</Text>
      <Text>{expectationLine(row.expectation)}</Text>
      {row.declared ? null : (
        // A lab that only exists in history is a real situation with a real cause, and the runs
        // stay readable. Saying why beats leaving someone to wonder if the surface is broken.
        <Text color="yellow">no manifest in this project — renamed, deleted, or run from elsewhere</Text>
      )}
      {row.sharesIdWith > 0 ? (
        // Two manifests declaring one id is a misconfiguration the operator almost certainly does
        // not know about, and its consequence lands exactly here: the runs below belong to the id,
        // so they cannot be attributed to this file rather than the other one.
        <Text color="yellow">
          {row.sharesIdWith + 1} manifests declare id &quot;{row.labId}&quot; — the runs below are shared between them
        </Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {runs.length === 0 ? (
          <Text dimColor>no runs yet</Text>
        ) : (
          <RunList runs={runs} selected={selected} columns={columns} viewport={viewport} now={now} />
        )}
      </Box>
    </Box>
  );
}

function RunList({
  runs,
  selected,
  columns,
  viewport,
  now
}: {
  runs: RunIndexEntry[];
  selected: number;
  columns: number;
  viewport: number;
  now: number;
}): React.ReactElement {
  const window = listWindow({ total: runs.length, selected, viewport });
  return (
    <Box flexDirection="column">
      {window.start > 0 ? <Text dimColor>↑ {window.start} more</Text> : null}
      {runs.slice(window.start, window.end).map((run, offset) => (
        <RunRow key={run.runId} run={run} columns={columns} active={window.start + offset === selected} now={now} />
      ))}
      {window.end < runs.length ? <Text dimColor>↓ {runs.length - window.end} more</Text> : null}
    </Box>
  );
}

function RunRow({
  run,
  columns,
  active,
  now
}: {
  run: RunIndexEntry;
  columns: number;
  active: boolean;
  now: number;
}): React.ReactElement {
  const label = livenessLabel(run);
  const when = relativeTime(run, now);
  const right = run.durationMs === undefined ? when : `${when} · ${formatDuration(run.durationMs)}`;
  const room = Math.max(6, columns - right.length - label.length - 6);
  return (
    <Box>
      <Text {...color(active ? "cyan" : undefined)} bold={active}>
        {active ? "›" : " "} {truncateId(run.runId, room)}
      </Text>
      <Box flexGrow={1} />
      <Text {...color(colorFor(run))}>{label}</Text>
      <Text dimColor> {right}</Text>
    </Box>
  );
}

function colorFor(run: RunIndexEntry): string | undefined {
  if (run.liveness === "running") return "green";
  if (run.liveness === "interrupted") return "yellow";
  if (run.verdict === "fail") return "red";
  return undefined;
}

/**
 * Run ids carry their own timestamp (`cua-2026-08-19T07-44-13-489Z-…`), which is already shown as a
 * relative time beside the row. Cutting the middle keeps the two ends that identify it — the lane
 * prefix and the short hash — instead of a wall of digits.
 */
function truncateId(runId: string, width: number): string {
  if (runId.length <= width) return runId;
  if (width < 8) return `${runId.slice(0, Math.max(1, width - 1))}…`;
  const head = Math.ceil((width - 1) / 2);
  const tail = width - 1 - head;
  return `${runId.slice(0, head)}…${runId.slice(runId.length - tail)}`;
}

/** Coarse on purpose: minutes and hours are what "when did this run" means to a person. */
function relativeTime(run: RunIndexEntry, now: number): string {
  const stamp = run.completedAt ?? run.updatedAt ?? run.startedAt;
  if (stamp === undefined) return "unknown time";
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return "unknown time";
  const delta = now - parsed;
  if (delta < 0) return "just now";
  if (delta < 60_000) return "just now";
  return `${formatDuration(delta)} ago`;
}
