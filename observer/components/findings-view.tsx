import type { AutomaticAnalysisView } from "@/lib/automatic-analysis";
import type { ObserverData } from "@/lib/observer-data";
import type { RunNote } from "@/lib/run-notes";
import type { StudyReport as ReportData } from "@/lib/study-report";
import type { ObserverNavigation } from "@/lib/use-observer-navigation";
import type { useRunNotes } from "@/lib/use-run-notes";
import type { StudyPlayback } from "@/lib/use-study-playback";
import { StudyReport } from "./study-report";
import { ReviewerNotes } from "./reviewer-notes";

/**
 * The Findings view: the report and the reviewer notes beside it. Evidence opened from a finding,
 * the concerns or the design findings returns there. A note seeks the study clock to its moment
 * and shows its participant, or every participant.
 */
export function FindingsView({
  data,
  report,
  automatic,
  snapshot,
  now,
  navigation,
  notes,
  labels,
  playback,
}: {
  data: ObserverData;
  report: ReportData | undefined;
  automatic: AutomaticAnalysisView | undefined;
  snapshot: boolean;
  now: number;
  navigation: Pick<
    ObserverNavigation,
    | "findingId"
    | "selectFinding"
    | "concernsOpen"
    | "setConcernsOpen"
    | "openParticipant"
    | "toGrid"
  >;
  notes: ReturnType<typeof useRunNotes>;
  labels: Map<string, string>;
  playback: Pick<StudyPlayback, "recording" | "seek">;
}) {
  const openNote = (note: RunNote) => {
    const start = playback.recording.startMs;
    if (start !== null) playback.seek(start + note.atMs);
    if (note.participant !== null && data.streams.some((stream) => stream.id === note.participant))
      navigation.openParticipant(note.participant, { replay: true, keepClock: true });
    else navigation.toGrid();
  };
  return (
    <>
      <StudyReport
        data={data}
        report={report}
        {...(automatic ? { automatic } : {})}
        snapshot={snapshot}
        now={now}
        findingId={navigation.findingId ?? ""}
        onFinding={navigation.selectFinding}
        concernsOpen={navigation.concernsOpen}
        onConcernsOpen={navigation.setConcernsOpen}
        onOpen={(id, frame, eventId, findingId) =>
          navigation.openParticipant(id, {
            frame,
            eventId,
            from: findingId ? { kind: "finding", findingId } : { kind: "concerns" },
          })
        }
        onOpenDesign={(id, frame, eventId) =>
          navigation.openParticipant(id, { frame, eventId, from: { kind: "design" } })
        }
      />
      {notes.notes.length > 0 || notes.save || notes.unreadable ? (
        <ReviewerNotes
          notes={notes.notes}
          labels={labels}
          unreadable={notes.unreadable}
          writable={!!notes.save}
          onOpen={openNote}
        />
      ) : null}
    </>
  );
}
