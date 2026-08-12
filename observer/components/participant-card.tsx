import { formatDuration, keyframeHref } from "@/lib/artifact-href";
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
  if (PASS.has(stream.status)) return <span className="chip chip-pass">{stream.statusLabel}</span>;
  if (MUTED.has(stream.status)) return <span className="chip chip-dot chip-mute">{stream.statusLabel}</span>;
  return <span className="chip chip-dot">{stream.statusLabel}</span>;
}

// One card answers one question — "open this participant?" (#426): header bar
// (idx + lane + status chip), evidence thumb (keyframe when the lane recorded
// screenshots), meta line, then ONE signal line — a ⚑ typed badge with the recorded
// reason verbatim when something is notable, the closest report line otherwise.
export function ParticipantCard({ stream, onOpen }: { stream: ObserverStream; onOpen: (id: string) => void }) {
  const idx = String(stream.sim.index).padStart(2, "0");
  const keyframe = keyframeHref(stream);
  const signal = signalFor(stream);
  const meta = [
    stream.kindLabel,
    stream.sim.mode,
    stream.viewport ? `${stream.viewport.width}×${stream.viewport.height}` : stream.transport,
    ...(stream.actor ? [formatDuration(stream.actor.durationMs)] : [])
  ].join(" · ");
  const showTerminal = (stream.kind === "terminal" || stream.kind === "tui") && stream.terminalPlain !== "";

  return (
    <article className={MUTED.has(stream.status) ? "panel card gaveup" : "panel card"}>
      <button
        type="button"
        className="open-overlay"
        aria-label={`Open participant ${stream.label}`}
        onClick={() => onOpen(stream.id)}
      />
      <header className="pbar">
        <span className="pl">
          <b className="pidx">{idx}</b>
          <span className="pname">{stream.label}</span>
        </span>
        {statusChip(stream)}
      </header>
      {keyframe !== null ? (
        <div className="thumb">
          <img className="keyframe" src={keyframe} alt={`Keyframe from lane ${stream.label}`} loading="lazy" />
        </div>
      ) : showTerminal ? (
        <div className="thumb thumb-term">
          <TerminalCast lines={terminalLines(stream.terminalPlain)} />
        </div>
      ) : (
        <div className="thumb thumb-ph">
          <span className="o-label">{stream.embed?.title ?? stream.kindLabel}</span>
          {stream.ui ? <span className="ph-route">{stream.ui.route}</span> : null}
          <span className="ph-state">{stream.ui?.state ?? stream.transport}</span>
        </div>
      )}
      <p className="pmeta">{meta}</p>
      <footer className="pcap">
        <p className="prep">
          <span className="plab">{signal.flagged ? <><span className="flag">⚑</span> {signal.label}</> : signal.label}</span>
          <q>{signal.text}</q>
        </p>
      </footer>
    </article>
  );
}
