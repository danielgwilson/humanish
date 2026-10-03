import { Box, Text } from "ink";
import React from "react";

import type { RunDetail, RunParticipant } from "../../../src/run/detail.js";
import type { RunIndexEntry } from "../../../src/run/run-index.js";
import { formatDuration, normalizeThought } from "../../../src/run/projection.js";
import { indexedRunCost, runCostLabel } from "../../../src/run/run-cost.js";
import { fitLabelToWidth } from "../fit-text.js";
import { glyphColor, gutter, verdictGlyph } from "../frame.js";
import { PALETTE } from "../palette.js";
import { color } from "../text-props.js";

/**
 * What a run card can do. Only actions that actually work appear: `Share…` waits for the export
 * contract rather than shipping as a control that fails.
 */
export type RunAction = "observer" | "again" | "reclaim" | "stop" | "cancel-analysis";

export function runActions(run: RunIndexEntry, detail: RunDetail | null | undefined): RunAction[] {
  if (["queued", "running"].includes(detail?.automaticAnalysis?.state ?? "")) {
    return detail?.observerPath === undefined
      ? ["cancel-analysis"]
      : ["observer", "cancel-analysis"];
  }
  if (run.liveness === "interrupted") {
    // An interrupted run may have left sandboxes running, and that costs money until something
    // stops them. Reclaim leads; the evidence it did capture is still worth opening.
    return detail?.observerPath === undefined ? ["reclaim"] : ["reclaim", "observer"];
  }
  // A run that is going nowhere costs money every turn, and stopping it should not mean finding the
  // pid yourself, so Stop leads. The Observer server renders a running run from its saved bundle
  // (src/tui/actions.ts), so it opens mid-run too. "Run again" mid-flight would spend twice.
  if (run.liveness === "running")
    return detail?.observerPath === undefined ? ["stop"] : ["stop", "observer"];
  return detail?.observerPath === undefined ? ["again"] : ["observer", "again"];
}

function actionLabel(action: RunAction): string {
  switch (action) {
    case "observer":
      return "Open in Observer";
    case "again":
      return "Run again";
    case "stop":
      return "Stop this run";
    case "cancel-analysis":
      return "Cancel analysis";
    default:
      return "Reclaim: stop sandboxes, keep evidence";
  }
}

export interface RunScreenProps {
  run: RunIndexEntry;
  detail: RunDetail | null | undefined;
  columns: number;
  viewport: number;
  selected: number;
  tick: number;
  now: number;
  /** What the last action said. Always shown: an action that appears to do nothing is a bug. */
  actionNote: string | undefined;
}

/**
 * One run, as A card.
 *
 * The question changed, so the shape does: on the study screen you are watching, here you are asking
 * what happened. So the denominator leads (`1/1 reached the goal`, never a bare "pass") then the
 * participant's own closing words, then the real figure with its decomposition, then what you can
 * do about it.
 *
 * An interrupted run gets the same treatment at the same level rather than an apology: what it
 * managed, what it spent, whether anything is still running, and the action that stops it.
 */
export function RunScreen({
  run,
  detail,
  columns,
  selected,
  tick,
  now,
  actionNote,
}: RunScreenProps): React.ReactElement {
  const participant = detail?.participants[0];
  const actions = runActions(run, detail);
  const interrupted = run.liveness === "interrupted";

  return (
    <Box flexDirection="column">
      <Box>
        <Text {...glyphColor(run)} bold>
          {verdictGlyph({ ...run, tick })} {headline(run, participant)}
        </Text>
      </Box>

      {interrupted ? (
        <InterruptedFacts run={run} participant={participant} now={now} columns={columns} />
      ) : (
        <FinishedFacts run={run} participant={participant} columns={columns} />
      )}

      {detail?.automaticAnalysis === undefined ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text>Analysis: {detail.automaticAnalysis.state}</Text>
          {detail.automaticAnalysis.reason === null ? null : (
            <Text dimColor wrap="wrap">
              {detail.automaticAnalysis.reason}
            </Text>
          )}
        </Box>
      )}

      {actions.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          {actions.map((action, index) => (
            <Box key={action}>
              <Text
                {...color(index === selected ? PALETTE.accent : undefined)}
                bold={index === selected}
              >
                {gutter(index === selected)}{" "}
                {fitLabelToWidth(actionLabel(action), Math.max(10, columns - 3))}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Wrapped: a refusal here names its fix at the end, which truncation would cut. */}
      {actionNote === undefined ? null : (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {actionNote}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * The verdict, with its denominator. `pass` alone says a run succeeded without saying at what, and
 * the count is the finding, not the label.
 */
function headline(run: RunIndexEntry, participant: RunParticipant | undefined): string {
  if (run.liveness === "interrupted") return "interrupted: no outcome recorded";
  if (run.liveness === "running") {
    // Until the run has written a participant record there is nobody to name, and "starting…" is
    // the true thing to say rather than a sentence with a hole where the person goes.
    const who = participant?.personaId ?? participant?.label;
    return who === undefined ? "starting…" : `${who} is working`;
  }
  const counts = run.participants;
  if (counts === undefined) return run.verdict ?? "finished, no verdict recorded";
  const friction =
    counts.reportedFriction === undefined || counts.reportedFriction === 0
      ? ""
      : ` · ${counts.reportedFriction} reported friction`;
  return `${counts.reachedGoal}/${counts.total} reached the goal${friction}`;
}

/** A finished run: what they said, then what it took, then what it cost. */
function FinishedFacts({
  run,
  participant,
  columns,
}: {
  run: RunIndexEntry;
  participant: RunParticipant | undefined;
  columns: number;
}): React.ReactElement {
  // The participant's own closing words, quoted. `completionReason` is the harness's word for the
  // same moment; theirs is the one worth the space.
  const closing =
    participant?.thought === undefined
      ? undefined
      : normalizeThought(participant.thought.text, { width: Math.max(16, columns), maxLines: 3 });

  const shape = [
    run.durationMs === undefined ? undefined : formatDuration(run.durationMs),
    participant?.turns === undefined ? undefined : `${participant.turns} turns`,
    participant?.thoughts === undefined ? undefined : `${participant.thoughts} thoughts`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box flexDirection="column">
      {closing === undefined ? null : (
        <Box marginTop={1} flexDirection="column">
          {closing.lines.map((line, index) => (
            <Text key={index}>
              {index === 0 ? `"${line}` : line}
              {index === closing.lines.length - 1 ? '"' : ""}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {shape === "" ? null : <Text dimColor>{shape}</Text>}
        <Text dimColor>{costLine(run, participant)}</Text>
      </Box>
    </Box>
  );
}

/**
 * An interrupted run, at the same level as a finished one. What it managed, what it spent, and
 * whether anything is still running, which is the part that keeps costing money.
 */
function InterruptedFacts({
  run,
  participant,
  now,
  columns,
}: {
  run: RunIndexEntry;
  participant: RunParticipant | undefined;
  now: number;
  columns: number;
}): React.ReactElement {
  const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const quiet = run.updatedAt === undefined ? Number.NaN : now - Date.parse(run.updatedAt);
  const captured = [
    participant?.thoughts === undefined ? undefined : `${participant.thoughts} thoughts`,
    participant?.actions === undefined ? undefined : `${participant.actions} actions`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box marginTop={1} flexDirection="column" width={columns}>
      <Text dimColor>
        {Number.isFinite(started) ? `started ${clockTime(started)}` : "start time not recorded"}
        {Number.isFinite(quiet) ? ` · quiet ${formatDuration(quiet)}` : ""}
        {captured === "" ? "" : ` · ${captured} captured`}
      </Text>
      <Box>
        {/* A run that died before pricing itself genuinely does not know what it spent, and saying
            so beats inventing a figure. The captured counts above are the proxy. */}
        <Text dimColor>
          {run.estimatedCostUsd === undefined && participant?.estimatedCostUsd === undefined
            ? "cost unknown: it ended before pricing itself"
            : costLine(run, participant)}
        </Text>
        <Text color={PALETTE.warn}>{"  sandboxes may still be running"}</Text>
      </Box>
    </Box>
  );
}

/**
 * `null` is a declared absent cost, `undefined` was never recorded, and neither is 0. An
 * interrupted run that spent money before dying must still say so. A run's own figure comes with
 * its analyses, as every surface that shows one run's cost reads it (src/run/run-cost.ts).
 */
function costLine(run: RunIndexEntry, participant: RunParticipant | undefined): string {
  // Not `??` between the two sources: `??` treats null as nullish, so a declared absent cost would
  // fall through to the participant's and then to "not recorded": collapsing the exact distinction
  // this function exists to keep. Only a genuinely missing field falls through.
  if (run.estimatedCostUsd === undefined) {
    const value = participant?.estimatedCostUsd;
    if (value === undefined) return "cost not recorded";
    if (value === null) return "cost declared absent";
    return `~$${value.toFixed(2)} participant model estimate`;
  }
  if (run.estimatedCostUsd === null && run.analysisCost === undefined)
    return "cost declared absent";
  return `run ${runCostLabel(indexedRunCost(run))}`;
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
