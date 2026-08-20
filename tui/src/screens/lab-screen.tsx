import { Box, Text } from "ink";
import React from "react";

import type { LabSummary } from "../../../src/lab-summary.js";
import type { RunDetail } from "../../../src/run-detail.js";
import type { RunIndexEntry } from "../../../src/run-index.js";
import type { LabRow } from "../../../src/run-projection.js";
import {
  expectationLine,
  formatDuration,
  labSummaryLine,
  listWindow,
  normalizeThought
} from "../../../src/run-projection.js";
import { glyphColor, gutter, verdictGlyph } from "../frame.js";
import { PALETTE } from "../palette.js";
import { color } from "../text-props.js";

/**
 * One row of the lab screen. Start and history share a cursor because they share a screen: pressing
 * Down from Start lands on the newest run, which is how it reads to someone holding an arrow key.
 * Defined once and used by everything that counts, indexes or opens a row.
 */
export type LabItem = { kind: "start" } | { kind: "run"; run: RunIndexEntry };

export function labItems(runs: readonly RunIndexEntry[], canStart: boolean): LabItem[] {
  return [...(canStart ? ([{ kind: "start" }] as LabItem[]) : []), ...runs.map((run): LabItem => ({ kind: "run", run }))];
}

export interface LabScreenProps {
  row: LabRow;
  summary: LabSummary | null | undefined;
  runs: RunIndexEntry[];
  /** Detail for the live run, so it can lead with its participant. */
  liveDetail: RunDetail | null | undefined;
  selected: number;
  columns: number;
  viewport: number;
  now: number;
  tick: number;
  canStart: boolean;
  /** Which mode the Start toggle is on. */
  mode: "dry-run" | "live";
  confirming: "live" | undefined;
  launchError: string | undefined;
  launchNote: string | undefined;
}

/**
 * The object, and where the lifecycle lives. What this study does, what it typically costs, one
 * action, then its runs newest-first — so idle, running and finished are one screen rather than
 * three, and the run you just started appears where you are already looking.
 */
export function LabScreen(props: LabScreenProps): React.ReactElement {
  const { row, summary, runs, selected, columns, viewport, now, tick, canStart } = props;
  const items = labItems(runs, canStart);

  return (
    <Box flexDirection="column">
      {summary?.description === undefined ? null : (
        <Text wrap="truncate-end">{firstSentence(summary.description)}</Text>
      )}
      {summary?.subject === undefined ? null : (
        <Text dimColor wrap="truncate-end">
          {[
            summary.subject,
            summary.participants,
            summary.model,
            // The effort is part of "which model" — a knob nobody could see is how it stayed
            // pinned at the provider default for every run humanish ever did (#497).
            summary.reasoningEffort === undefined ? undefined : `${summary.reasoningEffort} effort`
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
      <Box width={columns}>
        <Text dimColor wrap="truncate-end">
          {/* The SAME rule the labs list uses. Falling back to the mode-mixed expectation here put
              a dry-run-derived figure directly above a control that spends money. */}
          {labSummaryLine(row)}
          {capsLine(summary)}
        </Text>
        <Box flexGrow={1} />
        {summary?.keysReady === undefined ? null : (
          <Text {...color(summary.keysReady ? PALETTE.ok : PALETTE.warn)}>{summary.keysReady ? "keys ✓" : "keys ✗"}</Text>
        )}
      </Box>
      {summary?.keysReady === false ? (
        // Naming what is missing is only half of it. Someone reading this has the keys SOMEWHERE —
        // in a shell they sourced, a password manager, another project — and what they need is the
        // one command that makes them resolve here, every time, without pasting a value into a
        // terminal that is recording frames.
        <Text dimColor wrap="truncate-end">
          {summary.missingKeys?.join(", ")} not found — `humanish keys set openai` (or pass
          --env-file when you launch)
        </Text>
      ) : null}

      {props.launchNote === undefined ? null : (
        <Box marginTop={1}>
          <Text dimColor>{props.launchNote}</Text>
        </Box>
      )}
      {props.launchError === undefined ? null : (
        <Box marginTop={1}>
          <Text color={PALETTE.bad}>{props.launchError}</Text>
        </Box>
      )}

      {canStart ? <StartRow {...props} active={items[selected]?.kind === "start"} /> : null}
      {row.declared ? null : (
        <Box marginTop={1}>
          <Text color={PALETTE.warn}>no manifest here — renamed, deleted, or run from elsewhere</Text>
        </Box>
      )}
      {row.sharesIdWith > 0 ? (
        <Text color={PALETTE.warn}>
          {row.sharesIdWith + 1} manifests declare &quot;{row.labId}&quot; — these runs are shared between them
        </Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Runs</Text>
        {runs.length === 0 ? (
          <Text dimColor>  none yet</Text>
        ) : (
          <RunList
            runs={runs}
            liveDetail={props.liveDetail}
            selected={selected - (canStart ? 1 : 0)}
            columns={columns}
            viewport={Math.max(2, viewport - 6)}
            now={now}
            tick={tick}
            expectedMs={row.liveExpectation.medianDurationMs}
          />
        )}
      </Box>
    </Box>
  );
}

/**
 * ONE action with a mode toggle, as designed — not two rows.
 *
 * Safe because the commit is two keystrokes for a live run: ←/→ chooses the mode, the first Enter
 * arms and restates the cost, the second commits. Misreading the toggle therefore cannot spend
 * anything, which was the only argument for splitting it.
 */
function StartRow({
  mode,
  confirming,
  active,
  columns,
  row
}: LabScreenProps & { active: boolean }): React.ReactElement {
  const live = mode === "live";
  return (
    <Box marginTop={1} flexDirection="column">
      <Box width={columns}>
        <Text {...color(active ? PALETTE.accent : undefined)} bold={active}>
          {gutter(active)} Start{"  "}
        </Text>
        <Text {...color(live ? undefined : PALETTE.accent)} bold={!live} dimColor={live}>
          dry-run
        </Text>
        <Text dimColor> / </Text>
        <Text {...color(live ? PALETTE.warn : undefined)} bold={live} dimColor={!live}>
          live
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>{live ? "←→ switch" : "no spend"}</Text>
      </Box>
      {confirming === "live" ? (
        <Box marginTop={1}>
          <Text color={PALETTE.warn}>
            {"  "}start a live run? {expectationLine(row.liveExpectation)} · ⏎ confirm · esc cancel
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function RunList({
  runs,
  liveDetail,
  selected,
  columns,
  viewport,
  now,
  tick,
  expectedMs
}: {
  runs: RunIndexEntry[];
  liveDetail: RunDetail | null | undefined;
  selected: number;
  columns: number;
  viewport: number;
  now: number;
  tick: number;
  expectedMs: number | undefined;
}): React.ReactElement {
  const window = listWindow({ total: runs.length, selected, viewport });
  return (
    <Box flexDirection="column">
      {window.start > 0 ? <Text dimColor>  ↑ {window.start} more</Text> : null}
      {runs.slice(window.start, window.end).map((run, offset) =>
        run.liveness === "running" ? (
          <LiveRun
            key={run.runId}
            run={run}
            detail={liveDetail}
            active={window.start + offset === selected}
            columns={columns}
            now={now}
            tick={tick}
            expectedMs={expectedMs}
          />
        ) : (
          <PastRun
            key={run.runId}
            run={run}
            active={window.start + offset === selected}
            columns={columns}
          />
        )
      )}
      {window.end < runs.length ? <Text dimColor>  ↓ {runs.length - window.end} more</Text> : null}
    </Box>
  );
}

/**
 * The live run gets real vertical space and leads with the PARTICIPANT, then their thinking in
 * full, then activity and spend as one quiet trailing line. Mid-run, cost is a guard rail rather
 * than the subject — it answers a question before you start and after you finish.
 */
function LiveRun({
  run,
  detail,
  active,
  columns,
  now,
  tick,
  expectedMs
}: {
  run: RunIndexEntry;
  detail: RunDetail | null | undefined;
  active: boolean;
  columns: number;
  now: number;
  tick: number;
  expectedMs: number | undefined;
}): React.ReactElement {
  const participant = detail?.participants[0];
  const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const elapsed = Number.isFinite(started) ? clockOf(now - started) : undefined;
  const of = expectedMs === undefined ? "" : ` of ~${clockOf(expectedMs)}`;
  const thought =
    participant?.thought === undefined
      ? undefined
      : normalizeThought(participant.thought.text, { width: Math.max(16, columns - 6), maxLines: 3 });

  return (
    <Box flexDirection="column">
      <Box width={columns}>
        <Text {...color(active ? PALETTE.accent : undefined)} bold={active}>
          {gutter(active)}{" "}
        </Text>
        <Text color={PALETTE.ok}>{verdictGlyph({ liveness: "running", tick })} </Text>
        <Text {...color(active ? PALETTE.accent : undefined)} bold={active} wrap="truncate-end">
          {participant?.personaId ?? participant?.label ?? "starting…"}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>{elapsed === undefined ? "" : `${elapsed}${of}`}</Text>
      </Box>
      {thought === undefined ? null : (
        <Box flexDirection="column" marginLeft={4}>
          {thought.lines.map((line, index) => (
            <Text key={index} dimColor={index > 0}>
              {index === 0 ? `"${line}` : line}
              {index === thought.lines.length - 1 ? '"' : ""}
            </Text>
          ))}
        </Box>
      )}
      {participant === undefined ? null : (
        <Box width={columns}>
          <Text dimColor>{"    "}{activityLine(participant)}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Activity as one quiet trailing line: what they have done, not what it has cost. */
function activityLine(participant: NonNullable<RunDetail["participants"][number]>): string {
  const parts: string[] = [];
  if (participant.actions !== undefined) parts.push(`${participant.actions} actions`);
  if (participant.thoughts !== undefined) parts.push(`${participant.thoughts} thoughts`);
  if (participant.turns !== undefined) parts.push(`${participant.turns} turns`);
  return parts.length === 0 ? "working…" : parts.join(" · ");
}

/** A finished run in one line: when, what happened, and how much it cost. */
function PastRun({
  run,
  active,
  columns
}: {
  run: RunIndexEntry;
  active: boolean;
  columns: number;
}): React.ReactElement {
  const when = shortDate(run.completedAt ?? run.startedAt);
  const outcome =
    run.participants === undefined
      ? (run.verdict ?? "no verdict")
      : `${run.participants.reachedGoal}/${run.participants.total} reached the goal`;
  const cost =
    run.estimatedCostUsd === undefined || run.estimatedCostUsd === null
      ? ""
      : ` · ~$${run.estimatedCostUsd.toFixed(2)}`;
  const summary = [when, outcome].filter(Boolean).join(" · ") + cost;
  return (
    <Box width={columns}>
      <Text {...color(active ? PALETTE.accent : undefined)} bold={active}>
        {gutter(active)}{" "}
      </Text>
      <Text {...glyphColor(run)}>{verdictGlyph(run)} </Text>
      <Text {...color(active ? PALETTE.accent : undefined)} bold={active} wrap="truncate-end">
        {summary}
      </Text>
    </Box>
  );
}

function capsLine(summary: LabSummary | null | undefined): string {
  const lane = summary?.caps.laneUsd;
  const study = summary?.caps.studyUsd;
  if (lane === undefined && study === undefined) return "";
  const parts: string[] = [];
  if (lane !== undefined) parts.push(`$${lane} lane`);
  if (study !== undefined) parts.push(`$${study} study`);
  return ` · caps ${parts.join(" / ")}`;
}

/** The first sentence of a description: enough to say what the study is, in one line. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.indexOf(". ");
  return stop === -1 ? flat : flat.slice(0, stop + 1);
}

function shortDate(stamp: string | undefined): string {
  if (stamp === undefined) return "";
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function clockOf(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  return formatDuration(ms);
}
