import type { RecordingSource } from "@/lib/recording-source";
import { findingHeading, type StudyReport } from "@/lib/study-report";

const RETURN_LABELS = {
  participants: "Back to participants",
  comparison: "Back to comparison",
  concerns: "Back to concerns considered",
  design: "Back to design findings",
} as const;

/** The recording's way back to the view it was opened from. A finding is named by its heading. */
export function RecordingReturn({
  source,
  findings,
  onReturn,
}: {
  source: RecordingSource;
  findings: StudyReport["findings"] | undefined;
  onReturn: () => void;
}) {
  const finding =
    source.kind === "finding" ? findings?.find((item) => item.id === source.findingId) : undefined;
  const heading = finding ? findingHeading(finding) : undefined;
  return (
    <button
      className="recording-return"
      type="button"
      data-return-kind={source.kind}
      aria-label={
        source.kind === "finding"
          ? `Back to finding: ${heading ?? source.findingId}`
          : RETURN_LABELS[source.kind]
      }
      title={heading}
      onClick={onReturn}
    >
      ← {source.kind === "finding" ? (heading ?? "Back to finding") : RETURN_LABELS[source.kind]}
    </button>
  );
}
