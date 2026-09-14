import { Accordion } from "@base-ui-components/react/accordion";
import { ArrowRight, ChevronDown, Info } from "lucide-react";
import type { ObserverData } from "@/lib/observer-data";
import { participantLabels } from "@/lib/participant-label";
import { formatElapsed } from "@/lib/player-model";
import { reportProblem, resolveReportMoment, type StudyReport as ReportData } from "@/lib/study-report";

export function StudyReport({ data, report, findingId, onFinding, onOpen }: {
  data: ObserverData; report: ReportData; findingId: string;
  onFinding: (id: string) => void;
  onOpen: (streamId: string, frame: number, eventId: string | undefined, findingId: string) => void;
}) {
  const problem = reportProblem(data, report);
  const labels = participantLabels(data.streams);
  if (problem || (findingId && !report.findings.some((item) => item.id === findingId))) {
    return <section className="study-report-empty" role="alert"><h2>Findings unavailable</h2><p>{problem ?? "This finding could not be found."}</p></section>;
  }
  return <section className="study-report" aria-label="Study findings">
    <div className="findings-summary"><p>{report.summary}</p><span>{report.scope} · {report.findings.length} findings</span></div>
    <Accordion.Root className="findings-list" value={findingId ? [findingId] : []} multiple={false} onValueChange={(value) => onFinding(typeof value[0] === "string" ? value[0] : "")}>
      {report.findings.map((finding, index) => {
        const moments = finding.moments.map((moment) => ({ ...moment, resolved: resolveReportMoment(data, moment.streamId, moment.eventId)! }));
        const lead = moments.find((moment) => moment.eventId === finding.leadEventId) ?? moments[0]!;
        const open = (moment: typeof lead) => onOpen(moment.streamId, moment.resolved.frameIndex, moment.resolved.eventId, finding.id);
        return <Accordion.Item key={finding.id} value={finding.id} className="finding-row" data-finding-row={finding.id}>
          <Accordion.Header className="finding-heading" render={<h2 />}>
            <Accordion.Trigger className="report-finding" data-finding={finding.id}>
              <span className="report-rank">{String(index + 1).padStart(2, "0")}</span>
              <span className="finding-row-title"><span className="finding-row-heading"><strong>{finding.title}</strong><span className="report-impact">{finding.impact}</span></span><span>{finding.scope} · {moments.length} evidence moments</span></span>
              <ChevronDown size={16} aria-hidden="true" />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Panel className="finding-panel">
            <div className="report-detail">
              <div className="finding-interpretation">
                <p className="report-claim">{finding.summary}</p>
                <p className="report-scope"><Info size={14} aria-hidden="true" />{finding.limitation}</p>

              </div>
              <button type="button" className="report-evidence" onClick={() => open(lead)} data-report-evidence={lead.eventId} aria-label={`Inspect ${lead.label} in participant recording`}>
                <span className="report-evidence-heading"><span>{labels.get(lead.streamId) ?? lead.streamId}</span><span>{formatElapsed(lead.resolved.elapsedMs)}</span></span>
                <img src={lead.resolved.frame.href} width={1440} height={950} alt={lead.note} />
                <span className="report-evidence-caption"><span>{lead.note}</span><strong>Open recording <ArrowRight size={14} aria-hidden="true" /></strong></span>
              </button>
              <div className="finding-followup">
                <section className="report-next"><h3>What to check</h3><p>{finding.nextStep}</p></section>
                <details className="report-account"><summary>Participant feedback</summary><blockquote>{finding.account}</blockquote><p>{finding.accountSource}</p></details>
                <details className="report-priority"><summary>Why this priority</summary><p>{finding.priorityReason}</p></details>
              </div>
              <section className="report-moments" aria-label="Supporting moments"><h3>Evidence</h3><div>{moments.map((moment) => <button type="button" key={moment.eventId} data-report-moment={moment.eventId} onClick={() => open(moment)}><span>{formatElapsed(moment.resolved.elapsedMs)}</span><strong>{moment.label}</strong><ArrowRight size={14} aria-hidden="true" /></button>)}</div><p>Times start at the first capture in the participant recording.</p></section>
            </div>
          </Accordion.Panel>
        </Accordion.Item>;
      })}
    </Accordion.Root>
    <details className="report-method"><summary>About this analysis</summary>{report.methodology.map((text, index) => <p key={index}>{text}</p>)}</details>
  </section>;
}
