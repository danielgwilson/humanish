import { Tabs } from "@base-ui/react/tabs";
import { useRef, useState } from "react";
import { formatDuration } from "@/lib/artifact-href";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import type { PlayerModel } from "@/lib/player-model";
import { completionLabel } from "@/lib/signal";
import type { ParticipantAnalysis as AnalysisReview } from "@/lib/study-report";
import { INSPECTOR_WIDTH } from "@/lib/use-player-preferences";
import type { PlayerPlayback } from "@/lib/use-player-playback";
import { DEFAULT_ACTIVITY, PlayerActivity, type ActivitySettings } from "./player-activity";
import { ParticipantAnalysis } from "./participant-analysis";
import { ParticipantAssignment } from "./participant-assignment";
import { ParticipantFeedback } from "./participant-feedback";

type Tab = "actions" | "details" | "report";

/**
 * The participant inspector beside the stage: a resize handle and the Actions, Details and
 * Feedback tabs. It stays mounted while hidden (`open` false renders nothing), so the selected
 * tab and the activity settings survive hiding and showing it.
 */
export function PlayerInspector({
  open,
  width,
  onResize,
  data,
  stream,
  model,
  playback,
  analysisReview,
  name,
  feedPage,
  onFeedPage,
}: {
  open: boolean;
  width: number;
  /** Takes a function from the current width to the next one. */
  onResize: (update: (width: number) => number) => void;
  data: ObserverData;
  stream: ObserverStream;
  model: PlayerModel;
  playback: PlayerPlayback;
  analysisReview: AnalysisReview | undefined;
  /** The participant's display name. */
  name: string;
  feedPage: number | null;
  onFeedPage: (page: number | null) => void;
}) {
  const [tab, setTab] = useState<Tab>("actions");
  const [activity, setActivity] = useState<ActivitySettings>(DEFAULT_ACTIVITY);
  if (!open) return null;
  return (
    <>
      <InspectorResize width={width} onResize={onResize} />
      <Tabs.Root
        className="inspector"
        style={{ width }}
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
      >
        <Tabs.List className="itabs" aria-label="Participant inspector">
          {(["actions", "details", "report"] as const).map((value) => (
            <Tabs.Tab key={value} value={value}>
              {value === "report" ? "Feedback" : value}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="actions" className="action-panel">
          <PlayerActivity
            model={model}
            stream={stream}
            playback={playback}
            settings={activity}
            onSettings={setActivity}
            page={feedPage}
            onPage={onFeedPage}
          />
        </Tabs.Panel>
        <Tabs.Panel value="details" className="ipanel">
          {analysisReview ? <ParticipantAnalysis data={data} review={analysisReview} /> : null}
          <ParticipantAssignment stream={stream} />
          <ParticipantDetails
            data={data}
            stream={stream}
            model={model}
            playback={playback}
            name={name}
          />
        </Tabs.Panel>
        <Tabs.Panel value="report" className="ipanel">
          <ParticipantOutcome data={data} stream={stream} />
        </Tabs.Panel>
      </Tabs.Root>
    </>
  );
}

/** The inspector's width handle: drag it, or press the left and right arrow keys for 20px. */
function InspectorResize({
  width,
  onResize,
}: {
  width: number;
  onResize: (update: (width: number) => number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="inspector-resize"
      role="separator"
      aria-label="Inspector width"
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={INSPECTOR_WIDTH.min}
      aria-valuemax={INSPECTOR_WIDTH.max}
      aria-valuenow={width}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        onResize((current) => current + (event.key === "ArrowLeft" ? 20 : -20));
      }}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start) onResize(() => start.width + start.x - event.clientX);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}

/** The Details tab's facts: who took part, the recorded actor, what it did and the timing. */
function ParticipantDetails({
  data,
  stream,
  model,
  playback,
  name,
}: {
  data: ObserverData;
  stream: ObserverStream;
  model: PlayerModel;
  playback: PlayerPlayback;
  name: string;
}) {
  const { actor, viewport } = stream;
  const { actionCount, thoughtCount } = playback.rows;
  const timing = playback.controlled
    ? "study timeline"
    : model.paced === "recorded"
      ? "recorded pace"
      : "avg-paced";
  return (
    <div className="kv">
      <span className="k">Persona</span>
      <span className="v">{stream.sim.personaId}</span>
      <span className="k">Scenario</span>
      <span className="v">{data.run.scenario.title}</span>
      <span className="k">Participant</span>
      <span className="v">{name}</span>
      {actor ? (
        <>
          <span className="k">Actor</span>
          <span className="v">
            {actor.provider}
            {actor.ids.model !== undefined ? ` · ${actor.ids.model}` : ""}
          </span>
          <span className="k">Duration</span>
          <span className="v">{formatDuration(actor.durationMs)}</span>
        </>
      ) : null}
      <span className="k">Recorded</span>
      <span className="v">
        {actionCount} {actionCount === 1 ? "action" : "actions"}
        {thoughtCount > 0
          ? ` · ${thoughtCount} ${thoughtCount === 1 ? "thought" : "thoughts"}`
          : ""}
      </span>
      <span className="k">Timing</span>
      <span className="v">{timing}</span>
      {viewport ? (
        <>
          <span className="k">Viewport</span>
          <span className="v">
            {viewport.width}×{viewport.height}
          </span>
        </>
      ) : null}
      {actor?.affordanceUse ? (
        <>
          <span className="k">Affordances</span>
          <span className="v">
            {Object.entries(actor.affordanceUse.counts)
              .map(([kind, count]) => `${kind} ${count}`)
              .join(" · ")}
            {` · shortcuts ${actor.affordanceUse.shortcutTotal}`}
          </span>
        </>
      ) : null}
      {actor ? (
        <>
          <span className="k">Redaction</span>
          <span className="v">screenshots {actor.redaction.screenshots}</span>
        </>
      ) : null}
      <span className="k">Artifacts</span>
      <span className="v">
        {(stream.artifacts ?? []).length + data.artifactLinks.length} linked files
      </span>
    </div>
  );
}

/** The Feedback tab: the recorded outcome and reason, the participant's statements, the study's
 * known gaps and the participant's cost. */
function ParticipantOutcome({ data, stream }: { data: ObserverData; stream: ObserverStream }) {
  const actor = stream.actor;
  const endingLabel = completionLabel(stream);
  return (
    <>
      <div className="blk">
        <span className="o-label">Outcome</span>
        <p className="verbatim">
          {stream.statusLabel}
          {endingLabel !== undefined ? ` · ⚑ ${endingLabel}` : ""}
        </p>
      </div>
      {actor ? (
        <div className="blk">
          <span className="o-label">Recorded reason, verbatim</span>
          <p className="verbatim">“{actor.reason}”</p>
        </div>
      ) : null}
      <ParticipantFeedback data={data} stream={stream} />
      {data.run.knownGaps.length > 0 ? (
        <div className="blk">
          <span className="o-label">Study-level gaps</span>
          {data.run.knownGaps.map((gap) => (
            <p key={gap} className="verbatim dim">
              {gap}
            </p>
          ))}
        </div>
      ) : null}
      {actor?.executionProfile?.billing === "account-unknown" ? (
        <div className="blk">
          <span className="o-label">Account usage</span>
          <p className="verbatim">Codex account · dollar cost unknown</p>
        </div>
      ) : actor?.estimatedCost && typeof actor.estimatedCost.estimatedCostUsd === "number" ? (
        <div className="blk">
          <span className="o-label">Est. participant cost</span>
          <p className="verbatim">
            ~${actor.estimatedCost.estimatedCostUsd.toFixed(2)} (rates as of{" "}
            {actor.estimatedCost.ratesAsOf})
          </p>
        </div>
      ) : null}
    </>
  );
}
