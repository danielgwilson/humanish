import type { MouseEvent } from "react";
import type { AutomaticAnalysisNotice } from "@/lib/automatic-analysis";
import type { ObserverData } from "@/lib/observer-data";
import type { StudyReport } from "@/lib/study-report";
import type { ObserverNavigation } from "@/lib/use-observer-navigation";
import { ShareStatus } from "./study-details";

/** A plain primary click navigates in the page; a modified one is left to the browser. */
function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  navigate();
}

/**
 * The study's two views as links, Participants and Findings, with their counts and the share
 * grade. Findings stays the current view in a recording opened from it.
 */
export function StudyViewbar({
  data,
  navigation,
  report,
  hasFindings,
  automaticNotice,
  noteCount,
}: {
  data: ObserverData;
  navigation: Pick<
    ObserverNavigation,
    "findingId" | "selected" | "source" | "toGrid" | "openReport"
  >;
  report: StudyReport | undefined;
  /** The study has a report, an automatic analysis or reviewer notes to show. */
  hasFindings: boolean;
  /** Stands in for the findings count while there is no report. */
  automaticNotice: AutomaticAnalysisNotice | undefined;
  noteCount: number;
}) {
  const { selected, source } = navigation;
  const findingsView =
    navigation.findingId !== null ||
    (!!selected &&
      !!report &&
      (source.kind === "finding" || source.kind === "concerns" || source.kind === "design"));
  return (
    <section className="study-viewbar" aria-label="Study navigation">
      <nav className="study-views" aria-label="Study views">
        <a
          href="#"
          aria-label="All participants"
          aria-current={!findingsView ? "page" : undefined}
          onClick={(event) => followLink(event, navigation.toGrid)}
        >
          Participants <span>{data.streams.length}</span>
        </a>
        {hasFindings ? (
          <a
            href="#/report"
            aria-current={findingsView ? "page" : undefined}
            onClick={(event) => followLink(event, () => navigation.openReport())}
          >
            Findings{" "}
            <span aria-label={!report ? automaticNotice?.message : undefined}>
              {report ? report.findings.length : automaticNotice?.pending ? "…" : "—"}
            </span>
            {noteCount ? (
              <span className="viewbar-notes">
                {noteCount} {noteCount === 1 ? "note" : "notes"}
              </span>
            ) : null}
          </a>
        ) : null}
      </nav>
      <ShareStatus data={data} />
    </section>
  );
}
