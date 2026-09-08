import { ThemeToggle } from "./theme-toggle";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";

export function IconRail({ onRuns, runsActive, onLive, liveActive = false }: { onRuns: () => void; runsActive: boolean; onLive?: () => void; liveActive?: boolean }) {
  return (
    <div className="rail">
      <IconButton label="All participants" aria-pressed={runsActive} onClick={onRuns} {...(runsActive ? { "data-on": "" } : {})}><ReviewIcon name="grid" /></IconButton>
      <IconButton label="Running participants" aria-pressed={liveActive} onClick={onLive} {...(liveActive ? { "data-on": "" } : {})}><ReviewIcon name="activity" /></IconButton>
      <div className="grow" />
      <ThemeToggle />
    </div>
  );
}
