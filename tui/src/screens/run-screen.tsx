import { Box, Text } from "ink";
import React from "react";

import type { RunDetail, RunParticipant } from "../../../src/run-detail.js";
import type { RunIndexEntry } from "../../../src/run-index.js";
import { formatDuration, normalizeThought } from "../../../src/run-projection.js";
import { fitLabelToWidth } from "../fit-text.js";
import { glyphColor, gutter, verdictGlyph } from "../frame.js";
import { PALETTE } from "../palette.js";
import { color } from "../text-props.js";

/**
 * What a run card can DO. Only actions that actually work appear — `Share…` waits for the export
 * contract (#471) rather than shipping as a control that fails.
 */
export type RunAction = "observer" | "again" | "reclaim" | "stop";

export function runActions(run: RunIndexEntry, detail: RunDetail | null | undefined): RunAction[] {
  if (run.liveness === "interrupted") {
    // An interrupted run may have left sandboxes running, and that costs money until something
    // stops them. Reclaim leads; the evidence it did capture is still worth opening.
    return detail?.observerPath === undefined ? ["reclaim"] : ["reclaim", "observer"];
  }
  // A run that is going nowhere costs money every turn, and stopping it used to mean finding the
  // pid yourself. Nothing else belongs here: the Observer artifact is not written until it ends,
  // and "Run again" mid-flight is a way to spend twice by accident.
  if (run.liveness === "running") return ["stop"];
  return detail?.observerPath === undefined ? ["again"] : ["observer", "again"];
}

export function actionLabel(action: RunAction): string {
  switch (action) {
    case "observer":
      return "Open in Observer";
    case "again":
      return "Run again";
    case "stop":
      return "Stop this run";
    default:
      return "Reclaim — stop sandboxes, keep evidence";
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
  /** What the last action said. Always shown — an action that appears to do nothing is a bug. */
  actionNote: string | undefined;
}

/**
 * ONE RUN, AS A CARD.
 *
 * The question changed, so the shape does: on the lab screen you are watching, here you are asking
 * what happened. So the DENOMINATOR leads — `1/1 reached the goal`, never a bare "pass" — then the
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
  actionNote
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
        <InterruptedFacts run={run} detail={detail} participant={participant} now={now} columns={columns} />
      ) : (
        <FinishedFacts run={run} participant={participant} columns={columns} />
      )}

      {actions.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          {actions.map((action, index) => (
            <Box key={action}>
              <Text {...color(index === selected ? PALETTE.accent : undefined)} bold={index === selected}>
                {gutter(index === selected)} {fitLabelToWidth(actionLabel(action), Math.max(10, columns - 3))}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {actionNote === undefined ? null : (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {actionNote}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * The verdict, with its denominator. `pass` alone says a run succeeded without saying at what — and
 * the count is the finding, not the label.
 */
function headline(run: RunIndexEntry, participant: RunParticipant | undefined): string {
  if (run.liveness === "interrupted") return "interrupted — no outcome recorded";
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
  columns
}: {
  run: RunIndexEntry;
  participant: RunParticipant | undefined;
  columns: number;
}): React.ReactElement {
  // The participant's OWN closing words, quoted. `completionReason` is the harness's word for the
  // same moment; theirs is the one worth the space.
  const closing =
    participant?.thought === undefined
      ? undefined
      : normalizeThought(participant.thought.text, { width: Math.max(16, columns), maxLines: 3 });

  const shape = [
    run.durationMs === undefined ? undefined : formatDuration(run.durationMs),
    participant?.turns === undefined ? undefined : `${participant.turns} turns`,
    participant?.thoughts === undefined ? undefined : `${participant.thoughts} thoughts`
  ].filter(Boolean).join(" · ");

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
 * whether anything is STILL RUNNING — which is the part that keeps costing money.
 */
function InterruptedFacts({
  run,
  detail,
  participant,
  now,
  columns
}: {
  run: RunIndexEntry;
  detail: RunDetail | null | undefined;
  participant: RunParticipant | undefined;
  now: number;
  columns: number;
}): React.ReactElement {
  const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const quiet = run.updatedAt === undefined ? Number.NaN : now - Date.parse(run.updatedAt);
  const captured = [
    participant?.thoughts === undefined ? undefined : `${participant.thoughts} thoughts`,
    participant?.actions === undefined ? undefined : `${participant.actions} actions`
  ].filter(Boolean).join(" · ");

  return (
    <Box marginTop={1} flexDirection="column" width={columns}>
      <Text dimColor>
        {Number.isFinite(started) ? `started ${clockTime(started)}` : "start time not recorded"}
        {Number.isFinite(quiet) ? ` · quiet ${formatDuration(quiet)}` : ""}
        {captured === "" ? "" : ` · ${captured} captured`}
      </Text>
      <Box>
        {/* A run that died before pricing itself genuinely does not know what it spent, and saying
            so beats inventing a figure. The captured counts above are the honest proxy. */}
        <Text dimColor>
          {run.estimatedCostUsd === undefined && participant?.estimatedCostUsd === undefined
            ? "cost unknown — it ended before pricing itself"
            : costLine(run, participant)}
        </Text>
        <Text color={PALETTE.warn}>  sandboxes may still be running</Text>
      </Box>
    </Box>
  );
}

/**
 * `null` is a DECLARED absent cost, `undefined` was never recorded, and neither is 0. An
 * interrupted run that spent money before dying must still say so.
 */
function costLine(run: RunIndexEntry, participant: RunParticipant | undefined): string {
  // NOT `??` between the two sources: `??` treats null as nullish, so a DECLARED ABSENT cost would
  // fall through to the participant's and then to "not recorded" — collapsing the exact distinction
  // this function exists to keep. Only a genuinely missing field falls through.
  const value = run.estimatedCostUsd === undefined ? participant?.estimatedCostUsd : run.estimatedCostUsd;
  if (value === undefined) return "cost not recorded";
  if (value === null) return "cost declared absent";
  return `~$${value.toFixed(2)} estimated`;
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
