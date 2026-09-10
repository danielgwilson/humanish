import { useState } from "react";
import { formatDuration, keyframeHref } from "@/lib/artifact-href";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { completionLabel } from "@/lib/signal";
import { participantLabels } from "@/lib/participant-label";
import { ParticipantAssignment } from "./participant-assignment";

import TerminalCast, { type TerminalLine } from "./terminal-cast";

function evidenceLines(plain: string): TerminalLine[] {
  return plain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((text): TerminalLine => {
      if (text.startsWith("$ ")) return { kind: "cmd", text };
      if (text.startsWith("ok ")) return { kind: "ok", text: text.slice(3) };
      return { kind: "dim", text };
    });
}

// Frame-free lanes retain readable terminal output and their recorded events.
export function ParticipantStub({ data, stream, updating = true }: { data: ObserverData; stream: ObserverStream; updating?: boolean }) {
  const terminal = evidenceLines(stream.terminalPlain);
  const [terminalPage, setTerminalPage] = useState<number | null>(null);
  const [eventPage, setEventPage] = useState(0);
  const terminalPages = Math.max(1, Math.ceil(terminal.length / 50));
  const page = Math.min(terminalPage ?? terminalPages - 1, terminalPages - 1);
  const events = Math.min(eventPage, Math.max(0, Math.ceil(stream.timeline.length / 100) - 1));
  const keyframe = keyframeHref(stream);
  const actor = stream.actor;
  const affordance = actor?.affordanceUse;
  return (
    <div className="stub">
      <ParticipantAssignment stream={stream} />
      <p className="stub-note o-mono">
        This lane recorded no screenshot frames, so the review player has no timeline to run. Below is
        the recorded evidence it carries.
      </p>
      {keyframe !== null ? (
        <div className="blk">
          <span className="o-label">Keyframe — last recorded screenshot</span>
          <img className="stub-keyframe" src={keyframe} alt={`Keyframe from lane ${stream.label}`} />
        </div>
      ) : null}
      <div className="kv">
        <span className="k">Persona</span>
        <span className="v">{participantLabels(data.streams).get(stream.id) ?? stream.sim.personaId}</span>
        <span className="k">Scenario</span>
        <span className="v">{data.run.scenario.title}</span>
        <span className="k">Lane</span>
        <span className="v">{stream.label}</span>
        <span className="k">Kind</span>
        <span className="v">{stream.kindLabel}</span>
        <span className="k">{updating ? "Status" : "Status at capture"}</span>
        <span className="v">{stream.statusLabel}{completionLabel(stream) ? ` · ${completionLabel(stream)}` : ""}</span>
        <span className="k">Transport</span>
        <span className="v">{stream.transport}</span>
        <span className="k">Mode</span>
        <span className="v">{stream.sim.mode}</span>
        <span className="k">Step</span>
        <span className="v">{stream.sim.currentStep}</span>
        {stream.viewport ? (
          <>
            <span className="k">Viewport</span>
            <span className="v">{stream.viewport.width}×{stream.viewport.height}</span>
          </>
        ) : null}
        <span className="k">Updated</span>
        <span className="v">{stream.updatedAt}</span>
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
        {affordance ? (
          <>
            <span className="k">Affordances</span>
            <span className="v">
              {Object.entries(affordance.counts)
                .map(([kind, count]) => `${kind} ${count}`)
                .join(" · ")}
              {` · shortcuts ${affordance.shortcutTotal}`}
            </span>
          </>
        ) : null}
        {actor?.estimatedCost && typeof actor.estimatedCost.estimatedCostUsd === "number" ? (
          <>
            <span className="k">Est. lane cost</span>
            <span className="v">
              ~${actor.estimatedCost.estimatedCostUsd.toFixed(2)} (rates as of {actor.estimatedCost.ratesAsOf})
            </span>
          </>
        ) : null}
      </div>
      {actor ? <div className="blk"><span className="o-label">Recorded reason, verbatim</span><p className="verbatim">{actor.reason}</p></div> : null}
      {stream.terminalPlain !== "" ? (
        <div className="blk">
          <span className="o-label">Recorded terminal output · lines {page * 50 + 1}–{Math.min((page + 1) * 50, terminal.length)} of {terminal.length}</span>
          {terminalPages > 1 ? <nav className="stub-pages" aria-label="Terminal output pages"><button className="review-tool" type="button" disabled={page === 0} onClick={() => setTerminalPage(page - 1)}>Earlier output</button><button className="review-tool" type="button" disabled={page >= terminalPages - 1} onClick={() => setTerminalPage(page + 1)}>Later output</button></nav> : null}
          <div className="stub-term">
            <TerminalCast lines={terminal.slice(page * 50, (page + 1) * 50)} />
          </div>
        </div>
      ) : null}
      {stream.ui ? (
        <div className="blk">
          <span className="o-label">UI lane contract</span>
          <p className="verbatim">
            {stream.ui.route} — {stream.ui.intent}
          </p>
        </div>
      ) : null}
      <div className="blk">
        <span className="o-label">Timeline</span>
        {stream.timeline.length > 100 ? <nav className="stub-pages" aria-label="Event pages"><button className="review-tool" type="button" disabled={events === 0} onClick={() => setEventPage(events - 1)}>Earlier events</button><span>{events * 100 + 1}–{Math.min((events + 1) * 100, stream.timeline.length)} of {stream.timeline.length}</span><button className="review-tool" type="button" disabled={(events + 1) * 100 >= stream.timeline.length} onClick={() => setEventPage(events + 1)}>Later events</button></nav> : null}
        <div className="acts">
          {stream.timeline.slice(events * 100, (events + 1) * 100).map((event) => (
            <div key={event.id} className={event.level === "warn" ? "arow ev warn" : "arow ev"}>
              <span className="tc">{event.level}</span>
              <span>
                {event.type} — {event.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
