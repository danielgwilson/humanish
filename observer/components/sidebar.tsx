import { useState } from "react";
import { historyRunHref } from "@/lib/artifact-href";
import type { HistoryIndex } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";
import { ThemeToggle } from "./theme-toggle";

/** Optional in-memory study navigation for a collection of saved Observer artifacts. */
export interface StudyLibrary {
  entries: { runId: string; title: string; description: string }[];
  onSelect: (runId: string) => void;
}

export function Sidebar({ data, history, onRuns, updating = true, library }: {
  data: ObserverData; history: HistoryIndex | null; onRuns: () => void; updating?: boolean; library?: StudyLibrary;
}) {
  const [query, setQuery] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [limit, setLimit] = useState(30);
  const current: HistoryIndex["runs"][number] = { runId: data.run.runId, status: data.run.status, createdAt: data.run.createdAt, href: "", mode: data.run.mode, streamCount: data.streams.length, ...(data.runtime ? { runtimeState: data.runtime.state } : {}) };
  const allRuns = library ? library.entries.map((entry) => entry.runId === current.runId ? current : { runId: entry.runId, href: "", status: "unknown", mode: null, streamCount: 0 })
    : history?.runs.length ? history.runs.map((run) => run.runId === current.runId ? current : run) : [current];
  const isRunning = (run: HistoryIndex["runs"][number]) => run.runtimeState ? run.runtimeState === "running" : run.status === "running" || run.status === "preparing";
  const titleFor = (run: HistoryIndex["runs"][number]) => library?.entries.find((entry) => entry.runId === run.runId)?.title
    ?? (run.runId === data.run.runId ? data.run.scenario.title : Number.isFinite(Date.parse(run.createdAt ?? "")) ? new Date(run.createdAt!).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : run.runId);
  const matches = allRuns.filter((run) => (!onlyRunning || isRunning(run)) && `${titleFor(run)} ${run.runId}`.toLowerCase().includes(query.toLowerCase()));
  return <aside className="side" aria-label="Study library">
    <nav aria-label="Run library"><div className="grp">
      <span className="o-label">Studies <span className="library-count">{allRuns.length}</span></span>
      {allRuns.length > 1 ? <input className="library-search" aria-label="Find a run" placeholder="Find a study…" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(30); }} /> : null}
      {!library && updating ? <label className="library-running"><input type="checkbox" checked={onlyRunning} onChange={(e) => { setOnlyRunning(e.target.checked); setLimit(30); }} /> Running only</label> : null}
      {matches.slice(0, limit).map((run) => {
        const href = historyRunHref(run.runId);
        const entry = library?.entries.find((item) => item.runId === run.runId);
        const content = <><span className={`dot${isRunning(run) ? updating ? " active" : "" : ["pass", "passed", "complete"].includes(run.status) ? " ok" : ""}`} />
          <span className="run-entry"><span className="study-name">{titleFor(run)}</span><small>{entry ? entry.description : `${!updating && isRunning(run) ? `Captured while ${run.status}` : run.runtimeState === "running" ? "Running" : run.runtimeState === "unknown" || run.runtimeState === "interrupted" ? "Status unconfirmed" : run.status}${run.createdAt && Number.isFinite(Date.parse(run.createdAt)) ? ` · ${new Date(run.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`}</small></span></>;
        return entry || run.runId === data.run.runId ? <button key={run.runId} type="button" className="item" {...(run.runId === data.run.runId ? { "data-on": "", "aria-current": "true" as const } : {})} onClick={() => library ? library.onSelect(run.runId) : onRuns()} title={run.runId} data-study-id={run.runId}>{content}</button>
          : href ? <a key={run.runId} className="item" href={href} title={run.runId}>{content}</a> : null;
      })}
      {!matches.length ? <p>No matching studies.</p> : null}
      {matches.length > limit ? <button type="button" className="review-tool" onClick={() => setLimit((v) => v + 30)}>Show more studies</button> : null}
    </div></nav>
    <div className="library-utilities"><span>Appearance</span><ThemeToggle /></div>
  </aside>;
}
