import type { ReactNode } from "react";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { Wordmark } from "./wordmark";
import { StudyDetails } from "./study-details";

/** One study header. Its identity and utilities do not depend on the active branch. */
export function Topbar({ data, onLibrary, sideOpen, reviewControl, status, studyLabel }: {
  data: ObserverData; onLibrary: () => void; sideOpen: boolean; reviewControl?: ReactNode; status: ReactNode; studyLabel?: string;
}) {
  return <header className="topbar">
    <div className="workspace-brand"><Wordmark label="humanish Observer" /><IconButton className="side-toggle" label="Toggle run library" hint="Study library" aria-expanded={sideOpen} onClick={onLibrary}><ReviewIcon name="library" /></IconButton></div>
    <div className="study-heading"><h1 title={data.run.scenario.title}>{data.run.scenario.title}</h1><div className="study-meta">{studyLabel ? <span>{studyLabel}</span> : null}{status}</div></div>
    <div className="right">{reviewControl}<StudyDetails data={data} /></div>
  </header>;
}

export function ParticipantPager({ data, selected, onStep }: { data: ObserverData; selected: ObserverStream | null; onStep: (delta: number) => void }) {
  const index = data.streams.findIndex((stream) => stream.id === selected?.id);
  return <span className="pager">
    <IconButton label="Previous participant" onClick={() => onStep(-1)}><ReviewIcon name="previous" /></IconButton>
    <span className="pager-word">participant </span>{index + 1} / {data.streams.length}
    <IconButton label="Next participant" onClick={() => onStep(1)}><ReviewIcon name="next" /></IconButton>
  </span>;
}
