import { useEffect, useMemo, useRef, useState } from "react";

import { formatDuration } from "@/lib/artifact-href";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import type { PlayerModel } from "@/lib/player-model";
import { NOTABLE_COMPLETION } from "@/lib/signal";

type Tab = "actions" | "details" | "report";
const SPEEDS = [1, 4, 16] as const;

// The review player (#426): big stage, recorded click pins, transport, filmstrip,
// and the inspector tabs. Actions are the comments analog — every recorded row,
// click-to-seek, following the transport. Playback is avg-paced (see player-model.ts)
// and says so in the transport; it never pretends to be real timing.
export function Player({ data, stream, model }: { data: ObserverData; stream: ObserverStream; model: PlayerModel }) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [tab, setTab] = useState<Tab>("actions");
  const feedRef = useRef<HTMLDivElement | null>(null);

  const frames = model.frames;
  const current = frames[Math.min(frame, frames.length - 1)];
  const currentPins = useMemo(
    () => model.rows.filter((row) => row.frameIndex === frame && row.coord !== undefined),
    [model, frame]
  );

  useEffect(() => {
    if (!playing) return;
    if (frame >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const delay = Math.max(120, model.avgFrameMs / speed);
    const timer = setTimeout(() => setFrame((value) => Math.min(value + 1, frames.length - 1)), delay);
    return () => clearTimeout(timer);
  }, [playing, frame, speed, frames.length, model.avgFrameMs]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === " ") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
      if (event.key === "ArrowLeft") setFrame((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setFrame((value) => Math.min(frames.length - 1, value + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length]);

  useEffect(() => {
    const row = feedRef.current?.querySelector(`[data-frame-row="${frame}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [frame]);

  const seek = (index: number) => {
    setPlaying(false);
    setFrame(Math.max(0, Math.min(frames.length - 1, index)));
  };

  const actor = stream.actor;
  const raw = actor?.redaction.screenshots === "raw";
  const viewport = stream.viewport;

  return (
    <div className="player">
      <div className="viewer">
        <div className="stage">
          <div className="stage-box">
            {current ? <img src={current.href} alt={`Frame ${frame + 1} of ${frames.length} — ${current.title}`} /> : null}
            {viewport ? (
              <div className="pins" aria-hidden="true">
                {currentPins.map((row) => (
                  <span
                    key={row.id}
                    className="spin"
                    style={{
                      left: `${(100 * (row.coord?.x ?? 0)) / viewport.width}%`,
                      top: `${(100 * (row.coord?.y ?? 0)) / viewport.height}%`
                    }}
                  >
                    <span className="tip">{row.title}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="transport">
          <button type="button" className="tbtn" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((value) => !value)}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="tbtn" aria-label="Previous frame" onClick={() => seek(frame - 1)}>‹</button>
          <button type="button" className="tbtn" aria-label="Next frame" onClick={() => seek(frame + 1)}>›</button>
          <input
            className="scrub"
            type="range"
            min={0}
            max={frames.length - 1}
            value={frame}
            aria-label="Seek frame"
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span className="counter">{frame + 1} / {frames.length}</span>
          <span className="t-meta">
            {actor ? `${formatDuration(actor.durationMs)} · ` : ""}
            {model.rows.filter((row) => !row.isFrame).length} actions · avg-paced
          </span>
          <button
            type="button"
            className="tbtn speed"
            aria-label="Playback speed"
            onClick={() => setSpeed((value) => SPEEDS[(SPEEDS.indexOf(value) + 1) % SPEEDS.length] ?? 1)}
          >
            {speed}×
          </button>
          {raw ? <span className="rawchip" title="Raw local screenshots — redact before publishing">RAW</span> : null}
        </div>
        <div className="filmstrip">
          {frames.map((f) => (
            <button key={f.itemId} type="button" className="fs" {...(f.index === frame ? { "data-on": "" } : {})} onClick={() => seek(f.index)}>
              <span className="im">
                <img src={f.href} alt="" loading="lazy" />
              </span>
              <span className="lab">{f.title}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="inspector">
        <div className="itabs" role="tablist">
          {(["actions", "details", "report"] as const).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </div>
        {tab === "actions" ? (
          <div className="ipanel acts" ref={feedRef}>
            {model.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={row.isFrame ? "arow shot" : "arow"}
                {...(row.isFrame ? { "data-frame-row": row.frameIndex } : {})}
                {...(row.frameIndex === frame ? { "data-on": "" } : {})}
                onClick={() => seek(row.frameIndex)}
              >
                <span className="tc">T{String(row.frameIndex).padStart(2, "0")}</span>
                <span className="atext">{row.title}{row.text !== undefined && row.text !== "" ? ` — ${row.text}` : ""}</span>
              </button>
            ))}
          </div>
        ) : null}
        {tab === "details" ? (
          <div className="ipanel">
            <div className="kv">
              <span className="k">Persona</span>
              <span className="v">{data.run.persona.name}</span>
              <span className="k">Scenario</span>
              <span className="v">{data.run.scenario.title}</span>
              <span className="k">Lane</span>
              <span className="v">{stream.label}</span>
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
              {viewport ? (
                <>
                  <span className="k">Viewport</span>
                  <span className="v">{viewport.width}×{viewport.height}</span>
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
              <span className="v">{(stream.artifacts ?? []).length + data.artifactLinks.length} linked files</span>
            </div>
          </div>
        ) : null}
        {tab === "report" ? (
          <div className="ipanel">
            <div className="blk">
              <span className="o-label">Outcome</span>
              <p className="verbatim">
                {stream.statusLabel}
                {actor && NOTABLE_COMPLETION[actor.completionReason] !== undefined
                  ? ` — ⚑ ${NOTABLE_COMPLETION[actor.completionReason]}`
                  : ""}
              </p>
            </div>
            {actor ? (
              <div className="blk">
                <span className="o-label">Recorded reason — verbatim</span>
                <p className="verbatim">“{actor.reason}”</p>
              </div>
            ) : null}
            {data.run.knownGaps.length > 0 ? (
              <div className="blk">
                <span className="o-label">Known gaps</span>
                {data.run.knownGaps.map((gap) => (
                  <p key={gap} className="verbatim dim">{gap}</p>
                ))}
              </div>
            ) : null}
            {actor?.estimatedCost && typeof actor.estimatedCost.estimatedCostUsd === "number" ? (
              <div className="blk">
                <span className="o-label">Est. lane cost</span>
                <p className="verbatim">
                  ~${actor.estimatedCost.estimatedCostUsd.toFixed(2)} (rates as of {actor.estimatedCost.ratesAsOf})
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
