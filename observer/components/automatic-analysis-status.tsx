import {
  automaticAnalysisNotice,
  parseAutomaticAnalysis,
  type AutomaticAnalysisView,
} from "../lib/automatic-analysis";

export function AutomaticAnalysisStatus({
  automatic,
  snapshot,
  now,
  runId,
  separateAnalysis = false,
  resultAvailable = false,
}: {
  automatic: AutomaticAnalysisView;
  snapshot: boolean;
  now: number;
  /** Names the run in the command that runs an analysis refused for its cost. */
  runId?: string;
  separateAnalysis?: boolean;
  resultAvailable?: boolean;
}) {
  const notice = automaticAnalysisNotice(automatic, snapshot, now, runId);
  const reason = parseAutomaticAnalysis(automatic)?.reason;
  return (
    <>
      <div className="analysis-notice" role="status" data-automatic-analysis-state={notice.state}>
        <p>{notice.message}</p>
        <p className="analysis-status-detail">
          {!resultAvailable && (notice.state === "complete" || notice.state === "partial")
            ? "The analysis result is not available in this view. Participant evidence remains available."
            : notice.detail}
        </p>
        {notice.command ? (
          <p className="analysis-status-detail">
            <code>{notice.command}</code>
          </p>
        ) : null}
        {separateAnalysis ? (
          <p className="analysis-status-detail">
            The displayed report is from a separate analysis.
          </p>
        ) : null}
      </div>
      {reason ? (
        <details className="analysis-messages">
          <summary>Analysis details</summary>
          <p>
            Reason: <code>{reason}</code>
          </p>
        </details>
      ) : null}
    </>
  );
}
