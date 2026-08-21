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
export type LabItem = { kind: "start"; mode: LabRunMode } | { kind: "run"; run: RunIndexEntry };

export type LabRunMode = "dry-run" | "live";

/**
 * TWO start rows, not one row with a hidden mode.
 *
 * This was one row carrying a ←/→ toggle, on the argument that arming made a misread toggle
 * harmless. Both halves of that were wrong in practice. The stakeholder it was built for could not
 * find how to start a real run at all — a mode you have to press a key to discover is a mode most
 * people never discover — and the toggle ate ←/→ on that row, so the two keys that mean back and
 * open everywhere else in the app silently meant something different here. Splitting the row
 * restores both, and costs no safety: the live row still arms and still restates the spend.
 */
export function labItems(runs: readonly RunIndexEntry[], canStart: boolean): LabItem[] {
  const starts: LabItem[] = canStart
    ? [
        { kind: "start", mode: "dry-run" },
        { kind: "start", mode: "live" }
      ]
    : [];
  return [...starts, ...runs.map((run): LabItem => ({ kind: "run", run }))];
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
        // WRAPS, where every other line on this screen truncates. Truncation is right for a
        // status: half a duration still reads as a duration. It is wrong for the one instruction
        // that unblocks the screen — `humanish keys set openai` (or pass --e… ends mid-flag, and a
        // command you cannot finish typing is not advice.
        <Box flexDirection="column" width={columns}>
          <Text {...color(PALETTE.warn)}>{summary.missingKeys?.join(", ")} not found</Text>
          <Text dimColor>{"  "}humanish keys set openai{"   "}— stores them for every project</Text>
          <Text dimColor>{"  "}humanish tui --env-file .env{"   "}— or just this session</Text>
        </Box>
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

      {canStart ? (
        <Box marginTop={1} flexDirection="column">
          <StartRow {...props} mode="dry-run" active={activeStart(items, selected) === "dry-run"} />
          <StartRow {...props} mode="live" active={activeStart(items, selected) === "live"} />
          {/* The armed prompt RESTATES the spend rather than assuming the row above was read. That
              was the safety argument for the old hidden toggle, and it survives the split. */}
          {props.confirming === "live" ? (
            <Box marginTop={1}>
              <Text color={PALETTE.warn}>
                {"  "}start a live run? {expectationLine(props.row.liveExpectation)} · ⏎ confirm · esc cancel
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
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
            // Derived from the item model, never from a literal: the count of start rows changed
            // once already, and a hardcoded offset put a second cursor on the screen.
            selected={selected - labItems([], canStart).length}
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

/** Which start row the cursor is on, if any. */
function activeStart(items: readonly LabItem[], selected: number): LabRunMode | undefined {
  const item = items[selected];
  return item?.kind === "start" ? item.mode : undefined;
}

/**
 * One start row. The two of them are the whole lifecycle entry point, and they say what they cost
 * before you press anything: a dry run is free and a live one spends, so the row itself carries
 * the number rather than making you arm it to find out.
 *
 * The live row still arms — the first Enter restates the spend, the second commits — so the safety
 * that justified the old hidden toggle is intact while the option is now visible.
 */
function StartRow({
  mode,
  confirming,
  active,
  columns,
  row,
  summary
}: LabScreenProps & { active: boolean; mode: LabRunMode }): React.ReactElement {
  const live = mode === "live";
  const blocked = live && summary?.keysReady === false;
  const accent = live ? PALETTE.warn : PALETTE.accent;
  return (
    <Box width={columns}>
      <Text {...color(active ? accent : undefined)} bold={active} dimColor={blocked && !active}>
        {gutter(active)} {live ? "Start a LIVE run" : "Start a dry run"}
      </Text>
      <Box flexGrow={1} />
      {/* The price stays even when the keys are missing. Rev 9 replaced it with the gate, and a
          participant studying this screen reported exactly the consequence: "switching the TUI to
          live mode displayed no estimate or budget — only missing-key warnings". Whether a run is
          worth setting keys up FOR is the decision being made at that moment, so the number has to
          survive the blocker (labs/tui-self-study.yaml). */}
      <Text dimColor={!blocked} {...color(blocked ? PALETTE.warn : undefined)}>
        {live
          ? blocked
            ? `${expectationLine(row.liveExpectation)} · needs keys`
            : expectationLine(row.liveExpectation)
          : "free · no keys, no spend"}
      </Text>
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
