import CoverCanvas from "./cover-canvas";

/**
 * PersonaLane — one lane of a run: the keyframe a persona saw, its verbatim
 * final report, and an honest status chip. Failed lanes render as muted
 * "gave up" states, never hidden. The screenshot sits under a resolve-cover
 * veil that dissolves when the lane activates (reduced motion sees the
 * finished screenshot).
 *
 * The keyframe loads lazily: lanes live below the fold (in a replay track, or
 * stacked as a list on narrow screens), and eager keyframes otherwise get
 * hoisted into <head> as image preloads that compete with the first screen.
 */

export interface PersonaLaneProps {
  /** Two-digit lane index, e.g. "01" — also the cover-canvas glyph. */
  idx: string;
  /** Lane name as declared in the lab, e.g. "sticky-notes". */
  name: string;
  /** Keyframe screenshot for this lane. */
  img: string;
  alt: string;
  /** Caption label, e.g. "Final report — verbatim". */
  reportLabel: string;
  /** The persona's report, quoted verbatim. */
  report: string;
  passed: boolean;
  /** Right side of the panel bar. */
  right?: string;
  /** Chip text for each outcome. */
  passLabel?: string;
  failLabel?: string;
  /** Step index when composed inside a replay track. */
  dataI?: number;
  /** Marks the panel that sizes the stage in a replay track. */
  sizer?: boolean;
}

export default function PersonaLane({
  idx,
  name,
  img,
  alt,
  reportLabel,
  report,
  passed,
  right = "observer · replay",
  passLabel = "Passed",
  failLabel = "Gave up",
  dataI,
  sizer
}: PersonaLaneProps) {
  return (
    <article className="panel" {...(dataI !== undefined ? { "data-i": dataI } : {})} {...(sizer ? { "data-sizer": "" } : {})}>
      <header className="pbar"><span className="pl"><b className="pidx">{idx}</b><span className="pname">{name}</span></span><span className="pr">{right}</span></header>
      <div className="pmedia"><img src={img} alt={alt} loading="lazy" /><CoverCanvas n={idx} /></div>
      <footer className="pcap"><p className="prep"><span className="plab">{reportLabel}</span><q>{report}</q></p>{passed ? <span className="chip chip-pass">{passLabel}</span> : <span className="chip chip-dot chip-mute">{failLabel}</span>}</footer>
    </article>
  );
}
