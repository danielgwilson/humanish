import { Accordion } from "@base-ui-components/react/accordion";
import { ArrowRight, ChevronDown, Info } from "lucide-react";
import type { ObserverData } from "@/lib/observer-data";
import { participantLabels } from "@/lib/participant-label";
import { formatElapsed } from "@/lib/player-model";
import { basisLabel, reportProblem, resolveReportMoment, type StudyReport as ReportData } from "@/lib/study-report";
import { AutomaticAnalysisStatus } from "./automatic-analysis-status";
import { ANALYSIS_ADMISSION_EXCEEDED_DETAIL, automaticAnalysisNotice, type AutomaticStudyAnalysisView } from "@/lib/automatic-analysis";

export function StudyReport({ data, report, automatic, snapshot = false, now = Date.now(), findingId, onFinding, onOpen }: {
  data: ObserverData; report: ReportData | undefined; automatic?: AutomaticStudyAnalysisView; snapshot?: boolean; now?: number; findingId: string;
  onFinding: (id: string) => void;
  onOpen: (streamId: string, frame: number | null, eventId: string | undefined, findingId: string) => void;
}) {
  const automaticState = automatic ? automaticAnalysisNotice(automatic, snapshot, now).state : undefined;
  const sameAnalysis = !!report && automatic?.analysisId === report.id && automaticState === report.state;
  const automaticStatus = automatic && !sameAnalysis ? <AutomaticAnalysisStatus automatic={automatic} snapshot={snapshot} now={now}
    previousAnalysis={!!report && ["complete", "partial", "stale"].includes(report.state ?? "complete") && automatic.analysisId !== report.id}
    resultAvailable={!!report} /> : null;
  if (!report) return <section className="study-report" aria-label="Study findings">{automaticStatus}</section>;
  const problem = reportProblem(data, report);
  const labels = participantLabels(data.streams);
  if (problem || (findingId && !["invalid", "failed", "cancelled"].includes(report.state ?? "") && !report.findings.some((item) => item.id === findingId))) {
    return <section className="study-report-empty" role="alert"><h2>Findings unavailable</h2><p>{problem ?? "This finding could not be found."}</p></section>;
  }
  const state = report.state ?? "complete";
  const notice = state === "stale" ? "Evidence has changed since this analysis. Review these findings against the current recording or generate a new analysis."
    : state === "partial" ? "Analysis finished with limitations."
    : state === "failed" ? "Analysis failed. Participant evidence remains available."
    : state === "cancelled" ? "Analysis was cancelled. Participant evidence remains available."
    : state === "invalid" ? "Analysis is unavailable. Participant evidence remains available." : null;
  return <section className="study-report" aria-label="Study findings">
    {automaticStatus}
    {notice ? <p className="analysis-notice" role="status" data-analysis-state={state}>{notice}{report.admissionExceeded ? ` ${ANALYSIS_ADMISSION_EXCEEDED_DETAIL}` : ""}</p> : null}
    {report.messages?.length ? <details className="analysis-messages"><summary>Analysis notes ({report.messages.length})</summary>{report.messages.map((message, index) => <p key={index}>{message}</p>)}</details> : null}
    <div className="findings-summary"><p>{report.summary}</p><span>Independent analysis · {report.scope} · {report.findings.length} {report.findings.length === 1 ? "finding" : "findings"}</span></div>
    {!report.findings.length ? <div className="study-report-empty"><h2>{state === "complete" ? "No findings in the reviewed evidence" : "No findings available"}</h2><p>{state === "complete" ? "This analysis did not identify an issue in its declared coverage. It does not establish that every task or interaction was problem-free." : "The original participant recordings and feedback are still available in Participants."}</p></div> : null}
    <Accordion.Root className="findings-list" value={findingId ? [findingId] : []} multiple={false} onValueChange={(value) => onFinding(typeof value[0] === "string" ? value[0] : "")}>
      {report.findings.map((finding, index) => {
        const moments = finding.moments.map((moment) => ({ ...moment, resolved: resolveReportMoment(data, moment.streamId, moment.eventId) }));
        const lead = moments.find((moment) => moment.eventId === finding.leadEventId) ?? moments[0]!;
        const disposition = finding.corrections?.at(-1)?.status;
        const basis = (moment: typeof lead) => moment.bases?.map((value) => basisLabel[value]).join(" · ");
        const open = (moment: typeof lead) => { if (moment.resolved) onOpen(moment.streamId, moment.resolved.frameIndex, moment.resolved.eventId, finding.id); };
        const time = (moment: typeof lead) => moment.resolved?.elapsedMs !== null && moment.resolved?.elapsedMs !== undefined ? formatElapsed(moment.resolved.elapsedMs) : moment.resolved?.at ? new Date(moment.resolved.at).toLocaleTimeString() : "Time unavailable";
        return <Accordion.Item key={finding.id} value={finding.id} className="finding-row" data-finding-row={finding.id}>
          <Accordion.Header className="finding-heading" render={<h2 />}>
            <Accordion.Trigger className="report-finding" data-finding={finding.id}>
              <span className="report-rank">{String(index + 1).padStart(2, "0")}</span>
              <span className="finding-row-title"><span className="finding-row-heading"><strong>{finding.title}</strong><span className="report-impact">{finding.impact}</span>{disposition ? <span className="finding-disposition" data-disposition={disposition}>{disposition === "dismissed" ? "Dismissed" : disposition === "amended" ? "Amended" : "Confirmed"}</span> : null}</span><span>{finding.scope} · {moments.length} evidence {moments.length === 1 ? "moment" : "moments"}</span></span>
              <ChevronDown size={16} aria-hidden="true" />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Panel className="finding-panel">
            <div className="report-detail">
              <div className="finding-interpretation">
                <p className="report-claim">{finding.summary}</p>
                <p className="report-scope"><Info size={14} aria-hidden="true" />{finding.limitation}</p>
                {finding.observations?.length ? <details className="report-observations"><summary>Observation details ({finding.observations.length})</summary>{finding.observations.map((observation, index) => <div key={index}><span className="observation-basis">{basisLabel[observation.basis]}</span><p>{observation.claim}</p>{observation.limitation ? <p className="observation-limit">{observation.limitation}</p> : null}</div>)}</details> : null}
              </div>
              <button type="button" className="report-evidence" disabled={!lead.resolved} onClick={() => open(lead)} data-report-evidence={lead.eventId} aria-label={`Open recording: ${labels.get(lead.streamId) ?? lead.streamId} · ${time(lead)}`}>
                <span className="report-evidence-heading"><span>{labels.get(lead.streamId) ?? lead.streamId}</span><span>{time(lead)}</span></span>
                {lead.resolved?.frame ? <img src={lead.resolved.frame.href} alt="" /> : <span className="report-text-evidence">{lead.resolved?.text ?? "This evidence is no longer available in the current recording."}</span>}
                <span className="report-evidence-caption">{basis(lead) ? <span className="observation-basis">{basis(lead)}{lead.resolved?.frame && (lead.resolved.frame.itemId !== lead.eventId || !lead.bases?.includes("visual")) ? " · Capture shown for context" : ""}</span> : null}<span>{lead.note}</span><strong>Open recording <ArrowRight size={14} aria-hidden="true" /></strong></span>
              </button>
              <div className="finding-followup">
                <section className="report-next"><h3>What to check</h3><p>{finding.nextStep}</p></section>
                {finding.accounts?.length ? <details className="report-account"><summary>Cited participant statements</summary>{finding.accounts.map((account, index) => <figure key={`${account.streamId}/${account.eventId}/${index}`}><blockquote>{account.text}</blockquote><figcaption>{account.label}</figcaption></figure>)}</details> : finding.accounts === undefined && finding.account ? <details className="report-account"><summary>Participant feedback</summary><blockquote>{finding.account}</blockquote><p>{finding.accountSource}</p></details> : null}
                {finding.corrections?.map((correction, index) => <section key={index} className="finding-correction" aria-label="Reviewer annotation"><h3>{correction.status === "confirmed" ? "Confirmed by reviewer" : correction.status === "dismissed" ? "Dismissed by reviewer" : "Amended by reviewer"}</h3><p>{correction.reason}</p>{correction.replacementClaim ? <p>{correction.replacementClaim}</p> : null}<span>{correction.createdAt} · Original finding retained</span></section>)}
                <details className="report-priority"><summary>Why this priority</summary><p>{finding.priorityReason}</p></details>
              </div>
              <section className="report-moments" aria-label="Supporting moments"><h3>Evidence</h3><div>{moments.map((moment) => <button type="button" key={`${moment.streamId}/${moment.eventId}`} disabled={!moment.resolved} aria-current={moment === lead ? "true" : undefined} data-report-moment={moment.eventId} onClick={() => open(moment)}><span>{time(moment)}</span><span className="moment-source"><strong>{labels.get(moment.streamId) ?? moment.streamId}</strong><span>{basis(moment) ? `${basis(moment)} · ` : ""}{moment.label}</span></span><ArrowRight size={14} aria-hidden="true" /></button>)}</div><p>Elapsed times start at the first retained capture. Entries without a capture show their recorded clock time.</p></section>
            </div>
          </Accordion.Panel>
        </Accordion.Item>;
      })}
    </Accordion.Root>
    <details className="report-method"><summary>About this analysis</summary>{report.methodology.map((text, index) => <p key={index}>{text}</p>)}</details>
  </section>;
}
