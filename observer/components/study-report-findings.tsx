import { Accordion } from "@base-ui/react/accordion";
import { ArrowRight, ChevronDown, Info } from "lucide-react";
import type { ObserverData } from "@/lib/observer-data";
import { participantLabels } from "@/lib/participant-label";
import { formatRunTime } from "../../src/run/run-clock.js";
import {
  basisLabel,
  findingHeading,
  resolveReportMoment,
  representativeReportMoment,
  type StudyReport,
} from "@/lib/study-report";

type Finding = StudyReport["findings"][number];
type OpenMoment = (
  streamId: string,
  frame: number | null,
  eventId: string | undefined,
  findingId: string,
) => void;

/** A cited moment's elapsed time when its capture has one, else its recorded clock time. */
export function reportMomentTime(resolved: ReturnType<typeof resolveReportMoment>): string {
  return resolved?.elapsedMs !== null && resolved?.elapsedMs !== undefined
    ? formatRunTime(resolved.elapsedMs)
    : resolved?.at
      ? new Date(resolved.at).toLocaleTimeString()
      : "Time unavailable";
}

/** The ranked findings as a single-open accordion; `findingId` is the open row. */
export function StudyReportFindings({
  data,
  findings,
  state,
  findingId,
  onFinding,
  onOpen,
}: {
  data: ObserverData;
  findings: Finding[];
  state: NonNullable<StudyReport["state"]>;
  findingId: string;
  onFinding: (id: string) => void;
  onOpen: OpenMoment;
}) {
  const labels = participantLabels(data.streams);
  return (
    <>
      {!findings.length ? (
        <div className="study-report-empty">
          <h2>
            {state === "complete"
              ? "No findings in the reviewed evidence"
              : "No findings available"}
          </h2>
          <p>
            {state === "complete"
              ? "This analysis did not identify an issue in its declared coverage. It does not establish that every task or interaction was problem-free."
              : "The original participant recordings and feedback are still available in Participants."}
          </p>
        </div>
      ) : null}
      <Accordion.Root
        className="findings-list"
        value={findingId ? [findingId] : []}
        multiple={false}
        onValueChange={(value) => onFinding(typeof value[0] === "string" ? value[0] : "")}
      >
        {findings.map((finding, index) => (
          <FindingRow
            key={finding.id}
            data={data}
            finding={finding}
            rank={index + 1}
            labels={labels}
            onOpen={onOpen}
          />
        ))}
      </Accordion.Root>
    </>
  );
}

function FindingRow({
  data,
  finding,
  rank,
  labels,
  onOpen,
}: {
  data: ObserverData;
  finding: Finding;
  rank: number;
  labels: Map<string, string>;
  onOpen: OpenMoment;
}) {
  const moments = finding.moments.map((moment) => ({
    ...moment,
    resolved: resolveReportMoment(data, moment.streamId, moment.eventId),
  }));
  const lead = representativeReportMoment(moments, finding.leadEventId)!;
  const disposition = finding.corrections?.at(-1)?.status;
  const label = (moment: typeof lead) => labels.get(moment.streamId) ?? moment.streamId;
  const basis = (moment: typeof lead) =>
    moment.bases?.map((value) => basisLabel[value]).join(" · ");
  const open = (moment: typeof lead) => {
    if (moment.resolved)
      onOpen(moment.streamId, moment.resolved.frameIndex, moment.resolved.eventId, finding.id);
  };
  return (
    <Accordion.Item value={finding.id} className="finding-row" data-finding-row={finding.id}>
      <Accordion.Header className="finding-heading" render={<h2 />}>
        <Accordion.Trigger className="report-finding" data-finding={finding.id}>
          <span className="report-rank">{String(rank).padStart(2, "0")}</span>
          <span className="finding-row-title">
            <span className="finding-row-heading">
              <strong>{findingHeading(finding)}</strong>
              <span className="report-impact">{finding.impact}</span>
              {disposition ? (
                <span className="finding-disposition" data-disposition={disposition}>
                  {disposition === "dismissed"
                    ? "Dismissed"
                    : disposition === "amended"
                      ? "Amended"
                      : "Confirmed"}
                </span>
              ) : null}
            </span>
            <span>
              {finding.scope} · {moments.length} evidence{" "}
              {moments.length === 1 ? "moment" : "moments"}
            </span>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel className="finding-panel">
        <div className="report-detail">
          <div className="finding-interpretation">
            {finding.headline === undefined ? (
              <FindingEvidence finding={finding} />
            ) : (
              <>
                {finding.experience ? (
                  <p className="report-experience">{finding.experience}</p>
                ) : null}
                <details className="finding-evidence">
                  <summary>Evidence: {finding.title}</summary>
                  <FindingEvidence finding={finding} />
                </details>
              </>
            )}
          </div>
          <button
            type="button"
            className="report-evidence"
            disabled={!lead.resolved}
            onClick={() => open(lead)}
            data-report-evidence={lead.eventId}
            aria-label={`Open recording: ${label(lead)} · ${reportMomentTime(lead.resolved)}`}
          >
            <span className="report-evidence-heading">
              <span>{label(lead)}</span>
              <span>{reportMomentTime(lead.resolved)}</span>
            </span>
            {lead.resolved?.frame ? (
              <img src={lead.resolved.frame.href} alt="" />
            ) : (
              <span className="report-text-evidence">
                {lead.resolved?.text ??
                  "This evidence is no longer available in the current recording."}
              </span>
            )}
            <span className="report-evidence-caption">
              {basis(lead) ? (
                <span className="observation-basis">
                  {basis(lead)}
                  {lead.resolved?.frame &&
                  (lead.resolved.frame.itemId !== lead.eventId || !lead.bases?.includes("visual"))
                    ? " · Capture shown for context"
                    : ""}
                </span>
              ) : null}
              <span>{lead.note}</span>
              <strong>
                Open recording <ArrowRight size={14} aria-hidden="true" />
              </strong>
            </span>
          </button>
          <FindingFollowup finding={finding} />
          <section className="report-moments" aria-label="Supporting moments">
            <h3>Evidence</h3>
            <div>
              {moments.map((moment) => (
                <button
                  type="button"
                  key={`${moment.streamId}/${moment.eventId}`}
                  disabled={!moment.resolved}
                  aria-current={moment === lead ? "true" : undefined}
                  data-report-moment={moment.eventId}
                  onClick={() => open(moment)}
                >
                  <span>{reportMomentTime(moment.resolved)}</span>
                  <span className="moment-source">
                    <strong>{label(moment)}</strong>
                    <span>
                      {basis(moment) ? `${basis(moment)} · ` : ""}
                      {moment.label}
                    </span>
                  </span>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
            <p>
              Elapsed times start at the first retained capture. Entries without a capture show
              their recorded clock time.
            </p>
          </section>
        </div>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

/** The title, summary, assessment and observations: the evidence under a plain headline. */
function FindingEvidence({ finding }: { finding: Finding }) {
  const assessment = finding.assessment;
  const firstLimit = assessment ? assessment.limitations[0] : finding.limitation;
  return (
    <>
      <p className="report-claim">{finding.summary}</p>
      {assessment ? (
        <dl className="report-assessment" aria-label="Finding assessment">
          <div>
            <dt>Confidence</dt>
            <dd>{assessment.confidence}</dd>
          </div>
          <div>
            <dt>Recovery</dt>
            <dd>{assessment.recovery}</dd>
          </div>
        </dl>
      ) : null}
      {firstLimit ? (
        <p className="report-scope">
          <Info size={14} aria-hidden="true" />
          <span>{firstLimit}</span>
        </p>
      ) : null}
      {assessment ? (
        <details className="report-limits">
          <summary>
            Exposure
            {assessment.limitations.length > 1
              ? ` and ${assessment.limitations.length - 1} more evidence ${assessment.limitations.length === 2 ? "limit" : "limits"}`
              : " details"}
          </summary>
          <p>{assessment.exposureReason}</p>
          {assessment.limitations.length > 1 ? (
            <ul>
              {assessment.limitations.slice(1).map((limit, index) => (
                <li key={index}>{limit}</li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
      {finding.observations?.length ? (
        <details className="report-observations">
          <summary>Observation details ({finding.observations.length})</summary>
          {finding.observations.map((observation, index) => (
            <div key={index}>
              <span className="observation-basis">{basisLabel[observation.basis]}</span>
              <p>{observation.claim}</p>
              {observation.limitation ? (
                <p className="observation-limit">{observation.limitation}</p>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
    </>
  );
}

/** What to check next, the participants' words, reviewer corrections and the priority reason. */
function FindingFollowup({ finding }: { finding: Finding }) {
  return (
    <div className="finding-followup">
      <section className="report-next">
        <h3>What to check</h3>
        <p>{finding.nextStep}</p>
      </section>
      {finding.accounts?.length ? (
        <details className="report-account">
          <summary>Cited participant statements</summary>
          {finding.accounts.map((account, index) => (
            <figure key={`${account.streamId}/${account.eventId}/${index}`}>
              <blockquote>{account.text}</blockquote>
              <figcaption>{account.label}</figcaption>
            </figure>
          ))}
        </details>
      ) : finding.accounts === undefined && finding.account ? (
        <details className="report-account">
          <summary>Participant feedback</summary>
          <blockquote>{finding.account}</blockquote>
          <p>{finding.accountSource}</p>
        </details>
      ) : null}
      {finding.corrections?.map((correction, index) => (
        <section key={index} className="finding-correction" aria-label="Reviewer annotation">
          <h3>
            {correction.status === "confirmed"
              ? "Confirmed by reviewer"
              : correction.status === "dismissed"
                ? "Dismissed by reviewer"
                : "Amended by reviewer"}
          </h3>
          <p>{correction.reason}</p>
          {correction.replacementClaim ? <p>{correction.replacementClaim}</p> : null}
          <span>{correction.createdAt} · Original finding retained</span>
        </section>
      ))}
      <details className="report-priority">
        <summary>Why this priority</summary>
        <p>{finding.priorityReason}</p>
      </details>
    </div>
  );
}
