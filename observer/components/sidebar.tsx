import type { ObserverData } from "@/lib/observer-data";

const PASSED = new Set(["passed", "complete"]);

// Grouped sidebar: RUNS (this artifact carries exactly one run; the in-place run
// switcher over .humanish/runs arrives with the served library path in stage 3)
// and ARTIFACTS (relative links into the run directory — they resolve over file://).
export function Sidebar({ data, onRuns }: { data: ObserverData; onRuns: () => void }) {
  return (
    <div className="side">
      <nav>
        <div className="grp">
          <span className="o-label">Runs</span>
          <button type="button" className="item" data-on="" onClick={onRuns}>
            <span className={PASSED.has(data.run.status) ? "dot ok" : "dot bad"} />
            <span className="mono-id">{data.run.runId}</span>
          </button>
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
