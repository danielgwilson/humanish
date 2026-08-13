import { formatDuration, keyframeHref } from "@/lib/artifact-href";
import { liveEmbedUrl } from "@/lib/live";
import type { ObserverStream } from "@/lib/observer-data";
import { signalFor } from "@/lib/signal";

import TerminalCast, { type TerminalLine } from "./terminal-cast";

const PASS = new Set<string>(["passed", "complete"]);
const MUTED = new Set<string>(["abandoned", "incomplete", "blocked", "timed_out", "failed"]);

function terminalLines(plain: string): TerminalLine[] {
  return plain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 6)
    .map((text): TerminalLine => {
      if (text.startsWith("$ ")) return { kind: "cmd", text };
      if (text.startsWith("ok ")) return { kind: "ok", text: text.slice(3) };
      return { kind: "dim", text };
    });
}

function statusChip(stream: ObserverStream) {
  if (liveEmbedUrl(stream) !== null) return <span className="chip chip-dot">Live</span>;
  if (PASS.has(stream.status)) return <span className="chip chip-pass">{stream.statusLabel}</span>;
  if (MUTED.has(stream.status)) return <span className="chip chip-dot chip-mute">{stream.statusLabel}</span>;
  return <span className="chip chip-dot">{stream.statusLabel}</span>;
}

// The card is a mini viewport plus one decide-line (#426). The thumb dominates; the
// only overlays are what a stakeholder needs before clicking: duration, live state,
// and a play affordance. One row names the lane and its status. One line carries the
// signal: a flag with the recorded reason, or the lane's closest report line. Kind,
// mode, viewport, and the study name live in the player and the breadcrumb, not here.
export function ParticipantCard({ stream, onOpen }: { stream: ObserverStream; onOpen: (id: string) => void }) {
  const idx = String(stream.sim.index).padStart(2, "0");
  const keyframe = keyframeHref(stream);
  const signal = signalFor(stream);
  const live = liveEmbedUrl(stream) !== null;
  const showTerminal = (stream.kind === "terminal" || stream.kind === "tui") && stream.terminalPlain !== "";

  return (
    <article className={MUTED.has(stream.status) ? "panel card gaveup" : "panel card"}>
      <button
        type="button"
        className="open-overlay"
        aria-label={`Open participant ${stream.laneId ?? stream.label}`}
        onClick={() => onOpen(stream.id)}
      />
      <div className="thumb">
        {keyframe !== null ? (
          <img className="keyframe" src={keyframe} alt={`Keyframe from lane ${stream.laneId ?? stream.label}`} loading="lazy" />
        ) : showTerminal ? (
          <div className="thumb-term">
            <TerminalCast lines={terminalLines(stream.terminalPlain)} />
          </div>
        ) : (
          <div className="thumb-ph">
            {stream.ui ? <span className="ph-route">{stream.ui.route}</span> : null}
            <span className="ph-state">{stream.ui?.state ?? stream.transport}</span>
          </div>
        )}
        {stream.actor ? <span className="th-pill th-dur">{formatDuration(stream.actor.durationMs)}</span> : null}
        {live ? <span className="th-pill th-live">● live</span> : null}
        {keyframe !== null ? (
          <span className="th-play" aria-hidden="true">
            ▶
          </span>
        ) : null}
      </div>
      <div className="cbar">
        <b className="pidx">{idx}</b>
        <span className="cname">{stream.laneId ?? stream.label}</span>
        {statusChip(stream)}
      </div>
      <p className="csig">
        <span className={signal.flagged ? "sig-label sig-flag" : "sig-label"}>
          {signal.flagged ? "⚑ " : ""}
          {signal.label}
        </span>{" "}
        <q>{signal.text}</q>
      </p>
    </article>
  );
}
