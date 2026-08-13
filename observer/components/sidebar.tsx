import type { HistoryIndex } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";

const PASSED = new Set(["passed", "complete", "pass"]);

// Grouped sidebar: RUNS — this run over file://, the whole run library when served
// (the /_humanish/history.json index; switching runs is a navigation, each run's
// observer renders under its own path) — and ARTIFACTS (relative links into the
// run directory, resolving over file:// and http alike).
export function Sidebar({
  data,
  history,
  onRuns
}: {
  data: ObserverData;
  history: HistoryIndex | null;
  onRuns: () => void;
}) {
  const libraryRuns = history !== null && history.runs.length > 0 ? history.runs : null;
  return (
    <div className="side">
      <nav>
        <div className="grp">
          <span className="o-label">Runs</span>
          {libraryRuns ? (
            libraryRuns.map((run) =>
              run.runId === data.run.runId ? (
                <button key={run.runId} type="button" className="item" data-on="" onClick={onRuns}>
                  <span className={PASSED.has(run.status) ? "dot ok" : "dot bad"} />
                  <span className="mono-id" title={run.runId}>{run.runId}</span>
                </button>
              ) : (
                <a key={run.runId} className="item" href={run.href} title={run.runId}>
                  <span className={PASSED.has(run.status) ? "dot ok" : "dot bad"} />
                  <span className="mono-id">{run.runId}</span>
                </a>
              )
            )
          ) : (
            <button type="button" className="item" data-on="" onClick={onRuns}>
              <span className={PASSED.has(data.run.status) ? "dot ok" : "dot bad"} />
              <span className="mono-id">{data.run.runId}</span>
            </button>
          )}
        </div>
        <div className="grp">
          <span className="o-label">Artifacts</span>
          {data.artifactLinks.map((link) => (
            <a key={link.href} className="item dim" href={link.href}>
              <span className="mono-id">{link.label}</span>
            </a>
          ))}
        </div>
      </nav>
    </div>
  );
}
