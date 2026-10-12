import { useEffect, useRef } from "react";
import { boundedWindow, frameElapsedMs, type PlayerModel } from "@/lib/player-model";
import { formatRunTime } from "../../src/run/run-clock.js";

const FILMSTRIP_LIMIT = 40;

/** Thumbnails of the captures around the selected one, at most 40 at a time, with paging to the
 * rest. The selected thumbnail stays scrolled into view. */
export function PlayerFilmstrip({
  model,
  frame,
  onSeek,
}: {
  model: PlayerModel;
  frame: number;
  onSeek: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frames = model.frames;
  const shown = boundedWindow(frames.length, Math.max(0, frame), FILMSTRIP_LIMIT);
  useEffect(() => {
    // Scroll only as far as it takes to show the selected thumbnail.
    const pane = ref.current;
    const thumb = pane?.querySelector("[data-on]");
    if (!pane || !(thumb instanceof HTMLElement)) return;
    const p = pane.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    if (t.left < p.left) pane.scrollLeft += t.left - p.left;
    else if (t.right > p.right) pane.scrollLeft += t.right - p.right;
  }, [frame]);
  return (
    <div className="filmstrip" ref={ref} role="group" aria-label="Recorded frames">
      {shown.start > 0 ? (
        <button
          type="button"
          className="tbtn film-page"
          onClick={() => onSeek(Math.max(0, shown.start - 1))}
        >
          Earlier frames
        </button>
      ) : null}
      {frames.slice(shown.start, shown.end).map((f) => (
        <button
          key={f.itemId}
          type="button"
          className="fs"
          {...(f.index === frame ? { "data-on": "" } : {})}
          aria-label={`Frame ${f.index + 1}, ${formatRunTime(frameElapsedMs(model, f.index))}, ${f.title}`}
          onClick={() => onSeek(f.index)}
        >
          <span className="im">
            <img src={f.href} alt="" loading="lazy" decoding="async" />
          </span>
          <span className="lab">
            {formatRunTime(frameElapsedMs(model, f.index))} · {f.index + 1}
          </span>
        </button>
      ))}
      {shown.end < frames.length ? (
        <button type="button" className="tbtn film-page" onClick={() => onSeek(shown.end)}>
          Later frames
        </button>
      ) : null}
    </div>
  );
}
