import { Box, Text } from "ink";
import React from "react";

import type { LabRow } from "../../../src/run-projection.js";
import { expectationLine, listWindow } from "../../../src/run-projection.js";
import { fitPathToWidth } from "../fit-text.js";
import { color } from "../text-props.js";

export interface LabsScreenProps {
  rows: LabRow[];
  selected: number;
  columns: number;
  /** How many rows of list the frame can afford. */
  viewport: number;
  unattributed: number;
}

/**
 * The floor of the surface: every lab in this project, whether or not it has ever run.
 *
 * The row answers the two questions someone opens this to ask — "is anything happening right now"
 * and "which of these have I actually used" — and defers the rest to the lab screen. A lab that has
 * never run says so; it does not borrow another lab's numbers to look populated.
 */
export function LabsScreen({ rows, selected, columns, viewport, unattributed }: LabsScreenProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>no labs in this project</Text>
        <Text dimColor>`humanish init` writes a first lab manifest to humanish/labs/</Text>
      </Box>
    );
  }

  const window = listWindow({ total: rows.length, selected, viewport });
  return (
    <Box flexDirection="column">
      {window.start > 0 ? <Text dimColor>↑ {window.start} more</Text> : null}
      {rows.slice(window.start, window.end).map((row, offset) => (
        <LabRowView
          key={row.key}
          row={row}
          columns={columns}
          active={window.start + offset === selected}
        />
      ))}
      {window.end < rows.length ? <Text dimColor>↓ {rows.length - window.end} more</Text> : null}
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

function LabRowView({ row, columns, active }: { row: LabRow; columns: number; active: boolean }): React.ReactElement {
  const name = row.label;
  // Budget the status FIRST, from the width actually available, then give the name what is left.
  // Doing it the other way round is how a 66-character row ends up in a 45-column terminal: the
  // status is the variable-length half, so it is the half that has to adapt.
  const statusBudget = Math.max(9, Math.floor(columns / 2) - 2);
  const status = statusFor(row, statusBudget);
  // The pointer column is part of the layout, not decoration: without a reserved gutter every row
  // shifts by two characters when the selection lands on it.
  const gutter = active ? "\u203a" : " ";
  const room = Math.max(6, columns - status.length - 3);
  return (
    <Box width={columns}>
      <Text {...color(active ? "cyan" : undefined)} bold={active} wrap="truncate-end">
        {gutter} {fitPathToWidth(name, room)}
      </Text>
      <Box flexGrow={1} />
      <Text dimColor={!active} {...color(row.live > 0 ? "green" : undefined)} wrap="truncate-end">
        {status}
      </Text>
    </Box>
  );
}

/**
 * The right-hand half of a row. A live lab says so and nothing else — while something is running
 * that is the only fact worth the space.
 *
 * When the full expectation line does not fit, it degrades to the bare run count rather than being
 * cut mid-number: "12 runs" is true and useful, whereas "1m-4m \u00b7 ~$2.0\u2026" invites reading a
 * truncated figure as a real one. The full line is always available one screen in, on the lab.
 */
function statusFor(row: LabRow, budget: number): string {
  if (row.live > 0) return `${row.live} running`;
  if (row.runs === 0) return row.declared ? "never run" : "no runs";
  // Prefer the LIVE figure when there is one: cost and duration are what someone scans this column
  // for, and a median diluted by dry runs reports a live study as cheaper and faster than it is.
  // With no live history, report the count and claim nothing about either.
  const full =
    row.liveExpectation.sample > 0
      ? expectationLine(row.liveExpectation)
      : `${row.runs} ${row.runs === 1 ? "run" : "runs"}, none live`;
  if (full.length <= budget) return full;
  return `${row.runs} ${row.runs === 1 ? "run" : "runs"}`;
}
