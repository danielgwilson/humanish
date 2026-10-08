import { Text } from "ink";
import React from "react";

import type { StudySummary } from "../../src/study/summary.js";
import type { RunDetail } from "../../src/run/detail.js";
import type { Screen } from "./navigation.js";
import { PALETTE } from "./palette.js";
import { liveRunsOf, retiredFileOf, type ProjectData } from "./project.js";
import { AllRunsScreen } from "./screens/all-runs-screen.js";
import { RunScreen } from "./screens/run-screen.js";
import { StudiesScreen } from "./screens/studies-screen.js";
import { StudyScreen } from "./screens/study-screen.js";

/** A study's display name from its id, for screens that only carry the id. */
function labelForStudy(data: ProjectData, studyId: string | undefined): string {
  if (studyId === undefined) return "";
  return data.rows.find((row) => row.studyId === studyId)?.label ?? studyId;
}

/** The screen on top of the navigation stack, given what the surface has read and is doing. */
export function renderScreen(args: {
  screen: Screen;
  data: ProjectData;
  selected: number;
  columns: number;
  viewport: number;
  now: number;
  confirming: "live" | undefined;
  launchError: { studyKey: string; text: string } | undefined;
  launchNote: { studyKey: string; text: string } | undefined;
  detail: RunDetail | null | undefined;
  summary: StudySummary | null | undefined;
  liveDetails: Map<string, RunDetail>;
  tick: number;
  initialized: boolean;
  actionNote: string | undefined;
  initArmed?: boolean;
}): React.ReactElement {
  const {
    screen,
    data,
    selected,
    columns,
    viewport,
    now,
    confirming,
    launchError,
    launchNote,
    detail,
  } = args;
  const { summary, liveDetails, tick, initialized, actionNote } = args;
  if (screen.name === "studies") {
    return (
      <StudiesScreen
        rows={data.rows}
        selected={selected}
        columns={columns}
        viewport={viewport}
        unattributed={data.unattributed.length}
        tick={tick}
        initialized={initialized}
        retired={data.retired}
        peerSelected={selected === data.rows.length}
        liveTotal={liveRunsOf(data).length}
        {...(args.initArmed === true ? { initArmed: true } : {})}
        {...(args.actionNote === undefined ? {} : { actionNote: args.actionNote })}
        liveParticipants={
          new Map(
            [...liveDetails.entries()]
              .map(([runId, value]): [string, string] | null => {
                const who = value.participants[0]?.label;
                return who === undefined ? null : [runId, who];
              })
              .filter((entry): entry is [string, string] => entry !== null),
          )
        }
        now={now}
      />
    );
  }
  if (screen.name === "study") {
    const row = data.rows.find((candidate) => candidate.key === screen.studyKey);
    if (row === undefined)
      return <Text color={PALETTE.warn}>that study is no longer in this project</Text>;
    const retired = row.declared ? undefined : retiredFileOf(data, row.studyId)?.message;
    return (
      <StudyScreen
        row={row}
        summary={summary}
        runs={data.runsByStudy.get(row.studyId) ?? []}
        liveDetail={liveDetails.get(
          row.liveRuns[0]?.runId ?? data.runsByStudy.get(row.studyId)?.[0]?.runId ?? "",
        )}
        selected={selected}
        columns={columns}
        viewport={viewport}
        now={now}
        tick={tick}
        canStart={row.declared}
        {...(retired === undefined ? {} : { retired })}
        confirming={confirming}
        launchError={launchError?.studyKey === row.key ? launchError.text : undefined}
        launchNote={launchNote?.studyKey === row.key ? launchNote.text : undefined}
      />
    );
  }
  if (screen.name === "all-runs") {
    const live = liveRunsOf(data);
    return (
      <AllRunsScreen
        runs={live}
        details={liveDetails}
        labels={new Map(live.map((run) => [run.runId, labelForStudy(data, run.study?.id)]))}
        expected={
          new Map(
            data.rows
              .map((row): [string, number] | null =>
                row.liveExpectation.medianDurationMs === undefined
                  ? null
                  : [row.studyId, row.liveExpectation.medianDurationMs],
              )
              .filter((entry): entry is [string, number] => entry !== null),
          )
        }
        selected={selected}
        columns={columns}
        viewport={viewport}
        tick={tick}
        now={now}
      />
    );
  }
  const run = data.runsById.get(screen.runId);
  if (run === undefined) return <Text color={PALETTE.warn}>that run is no longer on disk</Text>;
  return (
    <RunScreen
      run={run}
      detail={detail}
      columns={columns}
      viewport={viewport}
      selected={selected}
      tick={tick}
      now={now}
      actionNote={actionNote}
    />
  );
}
