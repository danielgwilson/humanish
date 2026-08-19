import { Box, Text } from "ink";
import React from "react";

import type { RunIndexEntry } from "../../../src/run-index.js";
import { formatDuration, livenessLabel } from "../../../src/run-projection.js";
import { color } from "../text-props.js";

export interface RunScreenProps {
  run: RunIndexEntry;
  columns: number;
}

/**
 * One run. Its LIFECYCLE renders here rather than sending you to a different screen — a run that
 * finishes while you are looking at it should change in place, because it is still the same object.
 *
 * Every field is shown only when it was recorded. A dash for "not recorded" and a 0 for "cost
 * nothing" are different claims, and a surface that renders both as `$0.00` is lying about one of
 * them.
 */
export function RunScreen({ run, columns }: RunScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{run.runId}</Text>
      </Box>
      <Box>
        <Text {...color(colorFor(run))}>{livenessLabel(run)}</Text>
        {run.mode === undefined ? null : <Text dimColor> · {run.mode}</Text>}
        {run.lab?.id === undefined ? null : <Text dimColor> · {run.lab.id}</Text>}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Field label="started" value={run.startedAt} columns={columns} />
        <Field
          label="duration"
          value={run.durationMs === undefined ? undefined : formatDuration(run.durationMs)}
          columns={columns}
        />
        <Field label="participants" value={participantsLine(run)} columns={columns} />
        <Field label="cost" value={costLine(run)} columns={columns} />
        <Field label="from" value={sourceLine(run)} columns={columns} />
      </Box>

      {run.liveness === "interrupted" ? (
        <Box marginTop={1}>
          <Text color="yellow">
            this run has no outcome on disk — the process ended before it finished writing
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * A row that renders nothing at all when the value is absent, rather than an empty-looking one.
 *
 * Width-constrained so a long value WRAPS under its own column instead of running off the right
 * edge: on a phone-width terminal "2/2 reached the goal, 1 reported friction" is wider than the
 * screen, and an unconstrained row silently loses the end of the sentence.
 */
function Field({
  label,
  value,
  columns
}: {
  label: string;
  value: string | undefined;
  columns: number;
}): React.ReactElement | null {
  if (value === undefined) return null;
  const labelWidth = Math.min(14, Math.max(6, Math.floor(columns / 3)));
  return (
    <Box width={columns}>
      <Box width={labelWidth} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box width={Math.max(8, columns - labelWidth)}>
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}

function participantsLine(run: RunIndexEntry): string | undefined {
  const participants = run.participants;
  if (participants === undefined) return undefined;
  const friction =
    participants.reportedFriction === undefined ? "" : `, ${participants.reportedFriction} reported friction`;
  return `${participants.reachedGoal}/${participants.total} reached the goal${friction}`;
}

/**
 * `null` is a DECLARED absent cost and says so; `undefined` means the run never recorded the field
 * at all and the row is omitted. Neither is ever rendered as $0.00.
 */
function costLine(run: RunIndexEntry): string | undefined {
  if (run.estimatedCostUsd === undefined) return undefined;
  if (run.estimatedCostUsd === null) return "not recorded";
  return `~$${run.estimatedCostUsd.toFixed(2)} estimated`;
}

/** Where the listing's facts came from, so a surprising row can be traced to its source. */
function sourceLine(run: RunIndexEntry): string {
  switch (run.derivedFrom) {
    case "status":
      return "status.json";
    case "bundle":
      return "run.json (no status record)";
    default:
      return "the run directory alone";
  }
}

function colorFor(run: RunIndexEntry): string | undefined {
  if (run.liveness === "running") return "green";
  if (run.liveness === "interrupted") return "yellow";
  if (run.verdict === "fail") return "red";
  return undefined;
}
