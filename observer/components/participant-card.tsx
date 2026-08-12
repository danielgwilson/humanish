import type { ObserverStream } from "@/lib/observer-data";

import TerminalCast, { type TerminalLine } from "./terminal-cast";

const PASS = new Set<string>(["passed", "complete"]);
const NOTABLE = new Set<string>(["abandoned", "incomplete", "blocked", "timed_out", "failed"]);

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
  if (NOTABLE.has(stream.status)) return <span className="chip chip-dot chip-mute">{stream.statusLabel}</span>;
  return <span className="chip chip-dot">{stream.statusLabel}</span>;
}

// One card answers one question — "open this participant?" (#426): header bar
// (idx + lane + status chip), evidence thumb, meta line, then ONE signal line —
// a flagged event verbatim when something is notable, the lane summary otherwise.
export function ParticipantCard({ stream, onOpen }: { stream: ObserverStream; onOpen: (id: string) => void }) {
  const idx = String(stream.sim.index).padStart(2, "0");
  const warn = stream.timeline.find((event) => event.level === "warn");
  const meta = [
    stream.kindLabel,
    stream.sim.mode,
    stream.viewport ? `${stream.viewport.width}×${stream.viewport.height}` : stream.transport
  ].join(" · ");
  const showTerminal = (stream.kind === "terminal" || stream.kind === "tui") && stream.terminalPlain !== "";

  return (
    <article className={NOTABLE.has(stream.status) ? "panel card gaveup" : "panel card"}>
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
      {showTerminal ? (
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
          <span className="plab">{warn ? <><span className="flag">⚑</span> {warn.type}</> : "summary"}</span>
          <q>{warn ? warn.message : stream.sim.summary}</q>
        </p>
      </footer>
    </article>
  );
}
