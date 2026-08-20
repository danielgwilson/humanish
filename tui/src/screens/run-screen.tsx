import { Box, Text } from "ink";
import React from "react";

import type { RunDetail, RunParticipant } from "../../../src/run-detail.js";
import type { RunIndexEntry } from "../../../src/run-index.js";
import { formatDuration, livenessLabel, normalizeThought } from "../../../src/run-projection.js";
import { fitPathToWidth } from "../fit-text.js";
import { color } from "../text-props.js";

export interface RunScreenProps {
  run: RunIndexEntry;
  /** Who is in the run and what they are thinking. Absent until the run writes a bundle. */
  detail: RunDetail | null | undefined;
  columns: number;
  /** Rows this screen may use for participants before the facts block. */
  viewport: number;
}

/**
 * One run. Its LIFECYCLE renders here rather than sending you to a different screen — a run that
 * finishes while you are looking at it changes in place, because it is still the same object.
 *
 * THE PARTICIPANT LEADS. What someone watching a run wants is who is in there and what they are
 * currently thinking; cost is a number they check, not the thing they watch. So the persona, its
 * traits and its latest recorded thought sit at the top, and time and money go in the facts block
 * underneath.
 *
 * Every field is shown only when it was recorded. A dash for "not recorded" and a 0 for "cost
 * nothing" are different claims, and a surface that renders both as `$0.00` is lying about one.
 */
export function RunScreen({ run, detail, columns, viewport }: RunScreenProps): React.ReactElement {
  const participants = detail?.participants ?? [];
  // Split the space between however many lanes there are: one participant gets a paragraph of
  // thinking, four get a line each. Better to show every lane shallowly than one lane deeply and
  // leave the others invisible.
  const perParticipant = participants.length === 0 ? 0 : Math.floor(Math.max(0, viewport) / participants.length);
  const thoughtLines = Math.max(1, Math.min(4, perParticipant - 2));

  return (
    <Box flexDirection="column">
      <Text bold>{fitPathToWidth(run.runId, columns)}</Text>
      <Box>
        <Text {...color(colorFor(run))}>{livenessLabel(run)}</Text>
        {run.mode === undefined ? null : <Text dimColor> · {run.mode}</Text>}
        {run.lab?.id === undefined ? null : <Text dimColor> · {run.lab.id}</Text>}
      </Box>

      {participants.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            {detail === undefined ? "reading the run…" : "no participant record yet"}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {participants.map((participant) => (
            <Participant
              key={participant.id}
              participant={participant}
              columns={columns}
              thoughtLines={thoughtLines}
            />
          ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Field label="started" value={run.startedAt} columns={columns} />
        <Field
          label="duration"
          value={run.durationMs === undefined ? undefined : formatDuration(run.durationMs)}
          columns={columns}
        />
        <Field label="outcome" value={participantsLine(run)} columns={columns} />
        <Field label="cost" value={costLine(run)} columns={columns} />
        <Field label="observer" value={detail?.observerPath} columns={columns} />
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

/** One lane: who it is, how far they have got, and what they last thought. */
function Participant({
  participant,
  columns,
  thoughtLines
}: {
  participant: RunParticipant;
  columns: number;
  thoughtLines: number;
}): React.ReactElement {
  const progress = progressOf(participant);
  const nameRoom = Math.max(8, columns - progress.length - 2);
  // The thought is indented two columns and wrapped to what is left, so quoted speech reads as
  // quoted rather than as more of the surface's own chrome.
  const thought =
    participant.thought === undefined
      ? undefined
      : normalizeThought(participant.thought.text, { width: Math.max(12, columns - 2), maxLines: thoughtLines });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box width={columns}>
        <Text bold wrap="truncate-end">
          {fitPathToWidth(participant.label, nameRoom)}
        </Text>
        <Box flexGrow={1} />
        <Text {...color(participant.status === "running" ? "green" : undefined)} dimColor={participant.status !== "running"}>
          {progress}
        </Text>
      </Box>
      {participant.traits.length === 0 ? null : (
        <Text dimColor wrap="truncate-end">
          {participant.traits.join(" · ")}
        </Text>
      )}
      {thought === undefined ? (
        <Text dimColor>no recorded thinking yet</Text>
      ) : (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {thought.lines.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * How far a participant has got, in their own units. Turns and actions are what a computer-use lane
 * counts; a lane that counts neither says only what it is doing.
 */
function progressOf(participant: RunParticipant): string {
  const parts: string[] = [];
  if (participant.turns !== undefined) parts.push(`turn ${participant.turns}`);
  if (participant.actions !== undefined) parts.push(`${participant.actions} actions`);
  if (parts.length > 0) return parts.join(" · ");
  // A live participant has no turn count yet — the mid-run flush carries items, not counts — so
  // report what can be counted rather than inferring a turn number from the shape of the trace.
  if (participant.thoughts !== undefined) {
    return `${participant.thoughts} thought${participant.thoughts === 1 ? "" : "s"}`;
  }
  return participant.status ?? "";
}

/** A row that renders nothing at all when the value is absent, rather than an empty-looking one. */
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
      {/* Wraps rather than truncates. A path or an id that has been cut looks actionable and is
          not — the operator copies it, it fails, and the surface was the reason. */}
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
