import { automaticAnalysisNotice, parseAutomaticAnalysis, type AutomaticStudyAnalysisView } from "../lib/automatic-analysis";

export function AutomaticAnalysisStatus({ automatic, snapshot, now, previousAnalysis = false, resultAvailable = false }: {
  automatic: AutomaticStudyAnalysisView; snapshot: boolean; now: number; previousAnalysis?: boolean; resultAvailable?: boolean;
}) {
  const notice = automaticAnalysisNotice(automatic, snapshot, now);
  const reason = parseAutomaticAnalysis(automatic)?.reason;
  return <>
    <div className="analysis-notice" role="status" data-automatic-analysis-state={notice.state}>
      <p>{notice.message}</p>
      <p className="analysis-status-detail">{!resultAvailable && (notice.state === "complete" || notice.state === "partial")
        ? "The analysis result is not available in this view. Participant evidence remains available." : notice.detail}</p>
      {previousAnalysis ? <p className="analysis-status-detail">A previously saved analysis is shown below.</p> : null}
    </div>
    {reason ? <details className="analysis-messages"><summary>Analysis details</summary><p>Reason: <code>{reason}</code></p></details> : null}
  </>;
}
