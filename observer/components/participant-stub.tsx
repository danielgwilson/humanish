import { formatDuration, keyframeHref } from "@/lib/artifact-href";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";

import TerminalCast, { type TerminalLine } from "./terminal-cast";

function evidenceLines(plain: string): TerminalLine[] {
  return plain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 30)
    .map((text): TerminalLine => {
      if (text.startsWith("$ ")) return { kind: "cmd", text };
      if (text.startsWith("ok ")) return { kind: "ok", text: text.slice(3) };
      return { kind: "dim", text };
    });
}

// Stage-2 stub of the review player: the recorded evidence renders honestly (details,
// terminal tail, event timeline), and what is NOT built yet says so instead of
// pretending. The full player — stage, click pins, scrubber, filmstrip, tabs — is
// the stage-3 parity build (#426).
export function ParticipantStub({ data, stream }: { data: ObserverData; stream: ObserverStream }) {
  const keyframe = keyframeHref(stream);
  const actor = stream.actor;
  const affordance = actor?.affordanceUse;
  return (
    <div className="stub">
      <p className="stub-note o-mono">
        This lane recorded no screenshot frames, so the review player has no timeline to run — below is
        the recorded evidence it does carry.
      </p>
      {keyframe !== null ? (
        <div className="blk">
          <span className="o-label">Keyframe — last recorded screenshot</span>
          <img className="stub-keyframe" src={keyframe} alt={`Keyframe from lane ${stream.label}`} />
        </div>
      ) : null}
      <div className="kv">
        <span className="k">Persona</span>
        <span className="v">{data.run.persona.name}</span>
        <span className="k">Scenario</span>
        <span className="v">{data.run.scenario.title}</span>
        <span className="k">Lane</span>
        <span className="v">{stream.label}</span>
        <span className="k">Kind</span>
        <span className="v">{stream.kindLabel}</span>
        <span className="k">Status</span>
        <span className="v">{stream.statusLabel}</span>
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
      {stream.terminalPlain !== "" ? (
        <div className="blk">
          <span className="o-label">Recorded terminal tail</span>
          <div className="stub-term">
            <TerminalCast lines={evidenceLines(stream.terminalPlain)} />
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
        <div className="acts">
          {stream.timeline.map((event) => (
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
