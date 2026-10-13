import { comparisonFrame } from "@/lib/comparison";
import type { ObserverStream } from "@/lib/observer-data";
import type { PlayerModel } from "@/lib/player-model";
import { formatHash } from "@/lib/route";

/** Minutes and seconds, `m:ss`. */
export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** One compared participant, from this study or (with a `base`) from another run's page. */
export interface ComparisonEntry {
  stream: ObserverStream;
  name: string;
  run: string;
  /** The other run's page, which its frames and links resolve against; "" for this study. */
  base: string;
  model: PlayerModel | null;
  /** Frame times on the comparison clock; null when the recording has none on it. */
  times: number[] | null;
}

/**
 * One participant at the comparison cursor: the latest capture at or before it, never a later
 * one, with its age and frame number, and a link that opens that frame. A frame from this study
 * opens in this page; one from another run is left to the browser.
 */
export function ComparisonPanel({
  participant: p,
  at,
  serverStopped,
  failedImages,
  onFail,
  onRetry,
  onOpen,
}: {
  participant: ComparisonEntry;
  at: number;
  /** A failed frame shows nothing while no server answers; the page notice explains it. */
  serverStopped: boolean;
  failedImages: string[];
  onFail: (href: string) => void;
  onRetry: (href: string | null) => void;
  onOpen: (id: string, frame: number) => void;
}) {
  const selection = p.times ? comparisonFrame(p.times, at) : null;
  const frame = selection && selection.index >= 0 ? p.model?.frames[selection.index] : null;
  const href = frame
    ? p.base && !frame.href.startsWith("data:")
      ? new URL(frame.href, new URL(p.base, window.location.href)).href
      : frame.href
    : null;
  const failed = href !== null && !serverStopped && failedImages.includes(href);
  const unreachable = href !== null && serverStopped && failedImages.includes(href);
  return (
    <article className="compare-participant" data-stream-id={p.stream.id}>
      <h2>{p.name}</h2>
      <p className="compare-run">{p.run}</p>
      <div className="compare-stage">
        {unreachable ? null : href && !failed ? (
          <img src={href} alt={`Recorded frame from ${p.name}`} onError={() => onFail(href)} />
        ) : (
          <p>
            {failed
              ? "Frame unavailable"
              : !p.times
                ? "No capture timestamps"
                : "No capture yet at this time"}
          </p>
        )}
      </div>
      <p className="compare-caption">
        {selection && selection.index >= 0
          ? `${selection.coverage === "after" ? "Past recording end · last capture" : "Recorded capture"} · ${elapsed(selection.ageMs)} before cursor · frame ${selection.index + 1}${p.model?.paced === "avg" ? " · estimated timing" : ""}`
          : "Outside recorded coverage"}
      </p>
      {frame ? (
        <a
          className="review-tool compare-open"
          href={`${p.base}${formatHash(p.stream.id, frame.index)}`}
          aria-label={`Open frame ${frame.index + 1} from ${p.name}`}
          onClick={(event) => {
            if (
              p.base ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onOpen(p.stream.id, frame.index);
          }}
        >
          Open frame {frame.index + 1}
        </a>
      ) : null}
      {failed ? (
        <button type="button" className="review-tool" onClick={() => onRetry(href)}>
          Retry image
        </button>
      ) : null}
    </article>
  );
}
