import { observerArtifactHref } from "@/lib/artifact-href";
import type { ObserverData } from "@/lib/observer-data";
import { Popover } from "./ui/popover";
import { ReviewIcon } from "./review-icon";

export function StudyDetails({ data }: { data: ObserverData }) {
  return <Popover trigger={<ReviewIcon name="info" />} triggerClassName="study-details-trigger" label="Study details" title="Study details">
    <dl className="study-details"><dt>Scenario</dt><dd>{data.run.scenario.title}</dd><dt>Run ID</dt><dd className="study-exact-id">{data.run.runId}</dd><dt>Participants</dt><dd>{data.streams.length}</dd><dt>Recorded</dt><dd>{data.run.createdAt}</dd></dl>
    <nav className="study-files" aria-label="Evidence files">{data.artifactLinks.map((link) => {
      const href = observerArtifactHref(link.href); return href ? <a key={link.href} href={href}>{link.label}</a> : null;
    })}</nav>
  </Popover>;
}

export function ShareStatus({ data }: { data: ObserverData }) {
  const share = data.publicSafety.share;
  if (share) return <span className={`chip chip-dot ${share.status === "share_ready" ? "" : "chip-mute"}`} title={`verified ${share.verifiedAt}${share.reasons.length ? `: ${share.reasons.join(", ")}` : ""}`}>{({ share_ready: "Share-ready", local_only: "Local only", blocked: "Sharing blocked" })[share.status]}</span>;
  return data.publicSafety.publishable === false ? <span className="chip chip-dot chip-mute" title={data.publicSafety.note}>Local only</span> : null;
}
