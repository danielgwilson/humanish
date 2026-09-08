import { useState } from "react";
import { historyRunHref, observerArtifactHref } from "@/lib/artifact-href";
import type { HistoryIndex } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";

export function Sidebar({ data, history, onRuns }: { data: ObserverData; history: HistoryIndex | null; onRuns: () => void }) {
  const [query, setQuery] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [limit, setLimit] = useState(30);
  const allRuns = history?.runs.length ? history.runs : [{ runId: data.run.runId, status: data.run.status, createdAt: data.run.createdAt, href: "", mode: data.run.mode, streamCount: data.streams.length }];
  const matches = allRuns.filter((run) => (!onlyRunning || run.status === "running" || run.status === "preparing") && run.runId.toLowerCase().includes(query.toLowerCase()));
  return <div className="side"><nav aria-label="Run library"><div className="grp">
    <span className="o-label">Run library</span>
    <input className="library-search" aria-label="Find a run" placeholder="Find a run…" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(30); }} />
    <label className="library-running"><input type="checkbox" checked={onlyRunning} onChange={(e) => { setOnlyRunning(e.target.checked); setLimit(30); }} /> Running only</label>
    {matches.slice(0, limit).map((run) => {
      const href = historyRunHref(run.runId);
      const content = <><span className={`dot${run.status === "running" ? " active" : ["pass", "passed", "complete"].includes(run.status) ? " ok" : " bad"}`} />
        <span className="run-entry"><span className="mono-id">{run.runId}</span><small>{run.status}{run.createdAt && Number.isFinite(Date.parse(run.createdAt)) ? ` · ${new Date(run.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</small></span></>;
      return run.runId === data.run.runId ? <button key={run.runId} type="button" className="item" data-on="" onClick={onRuns} title={run.runId}>{content}</button>
        : href ? <a key={run.runId} className="item" href={href} title={run.runId}>{content}</a> : null;
    })}
    {!matches.length ? <p>No matching runs.</p> : null}
    {matches.length > limit ? <button type="button" className="review-tool" onClick={() => setLimit((v) => v + 30)}>Show more runs</button> : null}
  </div><div className="grp"><span className="o-label">Evidence files</span>{data.artifactLinks.map((link) => {
    const href = observerArtifactHref(link.href);
    return href ? <a key={link.href} className="item dim" href={href}><span className="mono-id">{link.label}</span></a> : null;
  })}</div></nav></div>;
}
