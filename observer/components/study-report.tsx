import type { ObserverData } from "@/lib/observer-data";
import { reportProblem, type StudyReport as ReportData } from "@/lib/study-report";
import { AutomaticAnalysisStatus } from "./automatic-analysis-status";
import { StudyReportConcerns } from "./study-report-concerns";
import { StudyReportDesign } from "./study-report-design";
import { StudyReportFindings } from "./study-report-findings";
import { StudyReportOverview } from "./study-report-overview";
import {
  ANALYSIS_ADMISSION_EXCEEDED_DETAIL,
  automaticAnalysisNotice,
  type AutomaticAnalysisView,
} from "@/lib/automatic-analysis";

/** What a stale or unusable analysis tells the reader before its findings. */
function stateNotice(state: NonNullable<ReportData["state"]>): string | null {
  return state === "stale"
    ? "Evidence has changed since this analysis. Review these findings against the current recording or generate a new analysis."
    : state === "partial"
      ? null
      : state === "failed"
        ? "Analysis failed. Participant evidence remains available."
        : state === "cancelled"
          ? "Analysis was cancelled. Participant evidence remains available."
          : state === "invalid"
            ? "Analysis is unavailable. Participant evidence remains available."
            : null;
}

export function StudyReport({
  data,
  report,
  automatic,
  snapshot = false,
  now = Date.now(),
  findingId,
  onFinding,
  onOpen,
  onOpenDesign,
  concernsOpen,
  onConcernsOpen,
}: {
  data: ObserverData;
  report: ReportData | undefined;
  automatic?: AutomaticAnalysisView;
  snapshot?: boolean;
  now?: number;
  findingId: string;
  onFinding: (id: string) => void;
  onOpen: (
    streamId: string,
    frame: number | null,
    eventId: string | undefined,
    findingId: string,
  ) => void;
  /** Opens a capture a design finding cites. */
  onOpenDesign: (streamId: string, frame: number | null, eventId: string | undefined) => void;
  concernsOpen?: boolean;
  onConcernsOpen?: (open: boolean) => void;
}) {
  const automaticState = automatic
    ? automaticAnalysisNotice(automatic, snapshot, now).state
    : undefined;
  const sameAnalysis =
    !!report && automatic?.analysisId === report.id && automaticState === report.state;
  const automaticStatus =
    automatic && !sameAnalysis ? (
      <AutomaticAnalysisStatus
        automatic={automatic}
        snapshot={snapshot}
        now={now}
        runId={data.run.runId}
        separateAnalysis={
          !!report &&
          ["complete", "partial", "stale"].includes(report.state ?? "complete") &&
          automatic.analysisId !== report.id
        }
        resultAvailable={!!report}
      />
    ) : null;
  if (!report)
    return (
      <section className="study-report" aria-label="Study findings">
        {automaticStatus}
      </section>
    );
  const problem = reportProblem(data, report);
  if (
    problem ||
    (findingId &&
      !["invalid", "failed", "cancelled"].includes(report.state ?? "") &&
      !report.findings.some((item) => item.id === findingId))
  ) {
    return (
      <section className="study-report-empty" role="alert">
        <h2>Findings unavailable</h2>
        <p>{problem ?? "This finding could not be found."}</p>
      </section>
    );
  }
  const state = report.state ?? "complete";
  const usable = ["complete", "partial", "stale"].includes(state);
  // Pending/unknown execution still needs attention. Terminal attempt history
  // must not impersonate the status of a separate, readable report.
  const history =
    usable &&
    automaticState !== "queued" &&
    automaticState !== "running" &&
    automaticState !== "unknown"
      ? automaticStatus
      : null;
  const notice = stateNotice(state);
  return (
    <section className="study-report" aria-label="Study findings">
      {history ? null : automaticStatus}
      {notice ? (
        <p
          className="analysis-notice"
          role="status"
          {...(usable ? {} : { "data-analysis-state": state })}
        >
          {notice}
        </p>
      ) : null}
      {report.admissionExceeded ? (
        <p className="analysis-notice" role="status" data-analysis-admission-exceeded>
          {ANALYSIS_ADMISSION_EXCEEDED_DETAIL}
        </p>
      ) : null}
      {usable ? (
        <StudyReportOverview report={report} history={history} />
      ) : report.messages?.length ? (
        <details className="analysis-messages">
          <summary>Analysis notes ({report.messages.length})</summary>
          <ul>
            {report.messages.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <StudyReportFindings
        data={data}
        findings={report.findings}
        state={state}
        findingId={findingId}
        onFinding={onFinding}
        onOpen={onOpen}
      />
      {report.designFindings !== undefined ? (
        <StudyReportDesign data={data} findings={report.designFindings} onOpen={onOpenDesign} />
      ) : null}
      {report.concernReviews !== undefined ? (
        <StudyReportConcerns
          data={data}
          reviews={report.concernReviews}
          open={concernsOpen}
          onOpenChange={onConcernsOpen}
          onFinding={onFinding}
          onOpen={onOpen}
        />
      ) : null}
      {!usable && report.methodology.length ? (
        <details className="report-method">
          <summary>About this analysis</summary>
          {report.methodology.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </details>
      ) : null}
    </section>
  );
}
