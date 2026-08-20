import { Box, Text } from "ink";
import React from "react";

import type { RunIndexEntry } from "../../../src/run-index.js";
import type { LabRow } from "../../../src/run-projection.js";
import { formatDuration, labSummaryLine, listWindow } from "../../../src/run-projection.js";
import { fitLabelToWidth } from "../fit-text.js";
import { glyphColor, gutter, spinnerFrame } from "../frame.js";
import { color } from "../text-props.js";

export interface LabsScreenProps {
  rows: LabRow[];
  selected: number;
  columns: number;
  viewport: number;
  unattributed: number;
  /** Advances the spinner on live rows. */
  tick: number;
  /**
   * runId -> participant label, for LIVE runs only. The index cannot carry this (it never opens a
   * bundle, which is the point of it), and a live lab that says "1 running" instead of who is in
   * there answers the less interesting half of the question. Live runs are few, so reading detail
   * for just those is affordable where reading it for the whole list would not be.
   */
  liveParticipants: Map<string, string>;
  /** Frozen in tests so an elapsed time is not the wall clock. */
  now: number;
}

/**
 * The home. Objects first — every lab in the project, whether or not it has ever run.
 *
 * A LAB SOMEONE IS WORKING IN SAYS WHO AND FOR HOW LONG, not what it is costing. That is the whole
 * reason the run board dissolved into this list: "is anything happening, and to whom" is answered
 * here, so the parallel-runs question needs no separate screen. Cost belongs one level in, on the
 * screen where you decide to spend it.
 */
export function LabsScreen({
  rows,
  selected,
  columns,
  viewport,
  unattributed,
  tick,
  liveParticipants,
  now
}: LabsScreenProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>no labs here yet</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>a lab is a study: who to send, to what, and what counts as done.</Text>
          <Text dimColor>`humanish init` writes three to start from.</Text>
        </Box>
      </Box>
    );
  }

  const window = listWindow({ total: rows.length, selected, viewport });
  return (
    <Box flexDirection="column">
      {window.start > 0 ? <Text dimColor>  ↑ {window.start} more</Text> : null}
      {rows.slice(window.start, window.end).map((row, offset) => (
        <LabRowView
          key={row.key}
          row={row}
          columns={columns}
          active={window.start + offset === selected}
          tick={tick}
          liveParticipants={liveParticipants}
          now={now}
        />
      ))}
      {window.end < rows.length ? <Text dimColor>  ↓ {rows.length - window.end} more</Text> : null}
      {unattributed > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            {unattributed} {unattributed === 1 ? "run" : "runs"} with no lab
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function LabRowView({
  row,
  columns,
  active,
  tick,
  liveParticipants,
  now
}: {
  row: LabRow;
  columns: number;
  active: boolean;
  tick: number;
  liveParticipants: Map<string, string>;
  now: number;
}): React.ReactElement {
  const live = row.liveRuns[0];
  const status = live === undefined ? labSummaryLine(row) : liveStatus(row, live, liveParticipants.get(live.runId), now);
  const statusBudget = Math.max(10, Math.floor(columns / 2) - 2);
  const shown = status.length <= statusBudget ? status : fallbackStatus(row);
  // Glyph column, name column, then the status flush right. The glyph gutter is part of the layout
  // rather than decoration: without it every row shifts sideways when the cursor lands on it.
  const nameRoom = Math.max(8, columns - shown.length - 6);
  return (
    <Box width={columns}>
      <Text {...color(active ? "cyan" : undefined)} bold={active}>
        {gutter(active)}{" "}
      </Text>
      <Text {...glyphColor({ liveness: live === undefined ? "finished" : "running" })}>
        {live === undefined ? " " : spinnerFrame(tick)}{" "}
      </Text>
      <Text {...color(active ? "cyan" : undefined)} bold={active} wrap="truncate-end">
        {fitLabelToWidth(row.label, nameRoom)}
      </Text>
      <Box flexGrow={1} />
      <Text {...color(live === undefined ? undefined : "green")} dimColor={live === undefined}>
        {shown}
      </Text>
    </Box>
  );
}

/**
 * What a live lab says about itself: the participant, and how long they have been at it. A person
 * scanning this list wants to know who is in there — not a count, and not a running total.
 */
function liveStatus(row: LabRow, live: RunIndexEntry, who: string | undefined, now: number): string {
  const started = live.startedAt === undefined ? Number.NaN : Date.parse(live.startedAt);
  const elapsed = Number.isFinite(started) ? clockOf(now - started) : undefined;
  // Until the run has written a participant record there is nobody to name, and "starting…" is the
  // true thing to say rather than borrowing the lab's own id and passing it off as a person.
  const label = who ?? "starting…";
  const extra = row.live > 1 ? ` +${row.live - 1}` : "";
  return elapsed === undefined ? `${label}${extra}` : `${label} · ${elapsed}${extra}`;
}

/** A narrow terminal keeps the fact and drops the detail. */
function fallbackStatus(row: LabRow): string {
  if (row.live > 0) return `${row.live} running`;
  return row.runs === 0 ? (row.declared ? "never run" : "no runs") : `${row.runs} runs`;
}

/** Elapsed as a clock (`3:12`), which is how a person reads "how long has this been going". */
function clockOf(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return formatDuration(ms);
}
