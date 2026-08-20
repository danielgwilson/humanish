import { Box, Text } from "ink";
import React from "react";

import type { RunDetail } from "../../../src/run-detail.js";
import type { RunIndexEntry } from "../../../src/run-index.js";
import { formatDuration, listWindow, normalizeThought } from "../../../src/run-projection.js";
import { fitLabelToWidth } from "../fit-text.js";
import { gutter, spinnerFrame } from "../frame.js";
import { color } from "../text-props.js";

export interface AllRunsScreenProps {
  runs: RunIndexEntry[];
  details: Map<string, RunDetail>;
  /** runId -> the lab it belongs to, for the middle column. */
  labels: Map<string, string>;
  /** Per-lab median duration, so a row can say how far through it is. */
  expected: Map<string, number>;
  selected: number;
  columns: number;
  viewport: number;
  tick: number;
  now: number;
}

/**
 * Everyone who is working, across every lab.
 *
 * PARTICIPANTS LEAD the rows and the labs follow, because when three studies are running at once
 * the question is who is doing what — the lab is how you find them again, not what you are watching.
 *
 * ONE THOUGHT LINE SERVES THE WHOLE SCREEN. Three concurrent participants each streaming their
 * thinking turns this into a log tail nobody can read, so only the selected row's thinking is
 * quoted, attributed underneath. Moving the cursor changes whose mind you are in.
 */
export function AllRunsScreen({
  runs,
  details,
  labels,
  expected,
  selected,
  columns,
  viewport,
  tick,
  now
}: AllRunsScreenProps): React.ReactElement {
  if (runs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>nobody is working right now</Text>
        <Text dimColor>start a run from any lab and it appears here</Text>
      </Box>
    );
  }

  const window = listWindow({ total: runs.length, selected, viewport: Math.max(2, viewport - 6) });
  const focused = runs[Math.min(Math.max(0, selected), runs.length - 1)];
  const focusedDetail = focused === undefined ? undefined : details.get(focused.runId);
  const participant = focusedDetail?.participants[0];
  const thought =
    participant?.thought === undefined
      ? undefined
      : normalizeThought(participant.thought.text, { width: Math.max(16, columns - 2), maxLines: 2 });

  return (
    <Box flexDirection="column">
      {runs.slice(window.start, window.end).map((run, offset) => (
        <RunRow
          key={run.runId}
          run={run}
          who={personaOf(details.get(run.runId)) ?? "starting…"}
          lab={labels.get(run.runId) ?? run.lab?.id ?? ""}
          expectedMs={expected.get(run.lab?.id ?? "")}
          active={window.start + offset === selected}
          columns={columns}
          tick={tick}
          now={now}
        />
      ))}

      {thought === undefined ? null : (
        <Box marginTop={1} flexDirection="column">
          {thought.lines.map((line, index) => (
            <Box key={index} width={columns}>
              {/* Fixed-width marker column: relying on a trailing space inside the Text loses it at
                  a wrap boundary, so continuation lines lose their indent. */}
              <Box width={2} flexShrink={0}>
                <Text color="cyan">▌</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {index === 0 ? `"${line}` : line}
                {index === thought.lines.length - 1 ? '"' : ""}
              </Text>
            </Box>
          ))}
          {/* Attribution stays on ONE line. Wrapped, it restarts at column zero and reads as more
              of the quote rather than the label underneath it. */}
          <Box width={columns}>
            <Box width={2} flexShrink={0}>
              <Text> </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {fitLabelToWidth(
                [personaOf(focusedDetail), labels.get(focused?.runId ?? "")].filter(Boolean).join(" · "),
                Math.max(10, columns - 2)
              )}
            </Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{spendLine(runs, details)}</Text>
      </Box>
    </Box>
  );
}

function personaOf(detail: RunDetail | undefined): string | undefined {
  const participant = detail?.participants[0];
  return participant?.personaId ?? participant?.label;
}

function RunRow({
  run,
  who,
  lab,
  expectedMs,
  active,
  columns,
  tick,
  now
}: {
  run: RunIndexEntry;
  who: string;
  lab: string;
  expectedMs: number | undefined;
  active: boolean;
  columns: number;
  tick: number;
  now: number;
}): React.ReactElement {
  const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const elapsed = Number.isFinite(started) ? clockOf(now - started) : "";
  const right = expectedMs === undefined ? elapsed : `${elapsed} / ~${clockOf(expectedMs)}`;
  // Three columns: who, where, how far. The middle one is the quietest — it is how you find them
  // again, not what you are watching.
  const whoRoom = Math.max(10, Math.floor((columns - right.length - 6) * 0.5));
  const labRoom = Math.max(8, columns - right.length - whoRoom - 6);
  return (
    <Box width={columns}>
      <Text {...color(active ? "cyan" : undefined)} bold={active}>
        {gutter(active)}{" "}
      </Text>
      <Text color="green">{spinnerFrame(tick)} </Text>
      <Box width={whoRoom}>
        <Text {...color(active ? "cyan" : undefined)} bold={active} wrap="truncate-end">
          {fitLabelToWidth(who, whoRoom)}
        </Text>
      </Box>
      <Box width={labRoom}>
        <Text dimColor wrap="truncate-end">
          {fitLabelToWidth(lab, labRoom)}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>{right}</Text>
    </Box>
  );
}

/**
 * Spend as ONE reassurance line: visible, not shouting. It reports what is known and says so when
 * a run has not priced itself yet — a total that silently omits the unpriced ones would read as a
 * smaller number than the truth.
 */
function spendLine(runs: readonly RunIndexEntry[], details: Map<string, RunDetail>): string {
  let total = 0;
  let priced = 0;
  for (const run of runs) {
    const value = run.estimatedCostUsd ?? details.get(run.runId)?.participants[0]?.estimatedCostUsd;
    if (typeof value === "number") {
      total += value;
      priced += 1;
    }
  }
  if (priced === 0) return "no spend recorded yet — a live run prices itself as it goes";
  const unpriced = runs.length - priced;
  const tail = unpriced === 0 ? "" : ` · ${unpriced} not priced yet`;
  return `spend ~$${total.toFixed(2)} so far across ${priced} of ${runs.length}${tail}`;
}

function clockOf(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  return formatDuration(ms);
}
