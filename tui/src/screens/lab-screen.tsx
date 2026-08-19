import { Box, Text } from "ink";
import React from "react";

import type { RunIndexEntry } from "../../../src/run-index.js";
import type { LabRow } from "../../../src/run-projection.js";
import { expectationLine, formatDuration, listWindow, livenessLabel } from "../../../src/run-projection.js";
import { color } from "../text-props.js";

/**
 * What one row of the lab screen IS. Actions and history share a single list because they share a
 * cursor: pressing Down from the last action lands on the newest run, which is how the screen reads
 * to someone who is just holding an arrow key.
 *
 * Defined once and consumed by everything that needs to count, index, or open a row — the classic
 * failure here is a screen whose "how many rows" and "what is row N" disagree by one.
 */
export type LabItem =
  | { kind: "start"; mode: "dry-run" | "live" }
  | { kind: "run"; run: RunIndexEntry };

export function labItems(runs: readonly RunIndexEntry[], canStart: boolean): LabItem[] {
  return [
    ...(canStart
      ? ([
          { kind: "start", mode: "dry-run" },
          { kind: "start", mode: "live" }
        ] as LabItem[])
      : []),
    ...runs.map((run): LabItem => ({ kind: "run", run }))
  ];
}

export interface LabScreenProps {
  row: LabRow;
  runs: RunIndexEntry[];
  selected: number;
  columns: number;
  viewport: number;
  now: number;
  /** False for a lab with no manifest here — there is nothing to start. */
  canStart: boolean;
  /** Set while a live start is awaiting confirmation. */
  confirming: "live" | undefined;
  /** Rendered when a launch could not happen. */
  launchError: string | undefined;
  /** A launch in flight. Not a failure, so it is not styled as one. */
  launchNote: string | undefined;
}

/**
 * One lab: what it is, what to expect from it, and everything it has done.
 *
 * The expectation line sits directly under the name because it is what someone reads before
 * deciding to spend money — and it always carries its own denominator, so "~$2.00 median" can never
 * be mistaken for a quote when it came from two runs.
 */
export function LabScreen({
  row,
  runs,
  selected,
  columns,
  viewport,
  now,
  canStart,
  confirming,
  launchError,
  launchNote
}: LabScreenProps): React.ReactElement {
  const items = labItems(runs, canStart);
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

      {launchNote === undefined ? null : (
        <Box marginTop={1}>
          <Text dimColor>{launchNote}</Text>
        </Box>
      )}
      {launchError === undefined ? null : (
        <Box marginTop={1}>
          <Text color="red">{launchError}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {canStart ? (
          <StartRows
            items={items}
            selected={selected}
            columns={columns}
            expectation={row.liveExpectation.sample > 0 ? expectationLine(row.liveExpectation) : "no live runs yet"}
            confirming={confirming}
          />
        ) : null}
        {runs.length === 0 ? (
          <Box marginTop={canStart ? 1 : 0}>
            <Text dimColor>no runs yet</Text>
          </Box>
        ) : (
          <Box marginTop={canStart ? 1 : 0} flexDirection="column">
            <RunList
              runs={runs}
              selected={selected - (canStart ? 2 : 0)}
              columns={columns}
              viewport={viewport}
              now={now}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * Two explicit rows rather than one row with a mode toggle.
 *
 * A toggle requires reading its current state correctly BEFORE pressing Enter, and misreading it
 * spends real money on a study you did not mean to run. Putting the mode in the action itself means
 * the wrong key cannot cost anything, and it leaves room to say what each one costs.
 */
function StartRows({
  items,
  selected,
  columns,
  expectation,
  confirming
}: {
  items: LabItem[];
  selected: number;
  columns: number;
  expectation: string;
  confirming: "live" | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((item, index) =>
        item.kind !== "start" ? null : (
          <Box key={item.mode} width={columns}>
            <Text {...color(index === selected ? "cyan" : undefined)} bold={index === selected}>
              {index === selected ? "›" : " "}{" "}
              {item.mode === "dry-run" ? "Start a dry run" : "Start a live run"}
            </Text>
            <Box flexGrow={1} />
            <Text dimColor={item.mode === "dry-run"} {...color(item.mode === "live" ? "yellow" : undefined)}>
              {item.mode === "dry-run" ? "no spend" : expectation}
            </Text>
          </Box>
        )
      )}
      {confirming === "live" ? (
        // A live run spends money the moment it starts, so the second keypress is the one that
        // commits — and it restates the cost rather than assuming it was read on the row above.
        <Box marginTop={1}>
          <Text color="yellow">start a live run? {expectation} · enter to confirm, esc to cancel</Text>
        </Box>
      ) : null}
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
