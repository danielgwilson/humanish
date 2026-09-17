import type { ReactNode } from "react";
import type { StudyReport } from "@/lib/study-report";

/** The current interpretation leads; original prose and execution records stay inspectable. */
export function StudyReportOverview({ report, history }: { report: StudyReport; history: ReactNode }) {
  const overview = report.overview;
  const state = report.state ?? "complete";
  const count = (included: number, total: number | null) => total === null ? included : `${included} / ${total}`;
  return <header className="report-overview">
    <div className="report-overview-title">
      <h2>{report.findings.length} {report.findings.length === 1 ? "finding" : "findings"}</h2>
      <span role="status" data-analysis-state={state}>{state === "stale" ? "Evidence changed" : state === "partial" ? "Report available · limitations" : "Report available"}</span>
    </div>
    {overview ? <dl className="report-overview-facts" aria-label="Analysis overview">
      <div><dt>Participants included</dt><dd>{count(overview.includedParticipants, overview.totalParticipants)}</dd></div>
      {overview.outcomes.map(outcome => <div key={outcome.label}><dt>{outcome.label} <span>(analysis)</span></dt><dd>{outcome.count}</dd></div>)}
      <div><dt>Captures sampled</dt><dd>{count(overview.sampledCaptures, overview.totalCaptures)}</dd></div>
    </dl> : <p className="report-overview-scope">Independent analysis · {report.scope}</p>}
    <div className="report-overview-disclosures">
      {report.summary ? <details className="report-summary"><summary>Study summary</summary><div className="findings-summary"><p>{report.summary}</p></div></details> : null}
      <details className="report-analysis-details"><summary>Coverage &amp; analysis details{report.messages?.length ? ` (${report.messages.length})` : ""}</summary>
        <div className="report-analysis-body">
          <p>Outcomes are analysis judgments. They do not replace participant accounts or recorded completion evidence. Captures sampled counts the images included in this analysis; other evidence may also be included.</p>
          {report.messages?.length ? <section className="analysis-messages"><h3>Analysis notes</h3><ul>{report.messages.map((message, index) => <li key={index}>{message}</li>)}</ul></section> : null}
          {history ? <section className="report-attempt"><h3>Automatic analysis attempt</h3>{history}</section> : null}
          <section className="report-method"><h3>About this analysis</h3>{report.methodology.map((text, index) => <p key={index}>{text}</p>)}</section>
        </div>
      </details>
    </div>
  </header>;
}
