import { ThemeToggle } from "./theme-toggle";

// Left icon rail (#426): Runs + Live only, register control at the bottom.
// Live is rendered but inert until the live poll path lands at parity (stage 3) —
// an honest disabled control beats a hidden one for discoverability.
export function IconRail({ onRuns, runsActive }: { onRuns: () => void; runsActive: boolean }) {
  return (
    <div className="rail">
      <button
        type="button"
        aria-label="Runs"
        title="Runs"
        onClick={onRuns}
        {...(runsActive ? { "data-on": "" } : {})}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
        </svg>
      </button>
      <button type="button" aria-label="Live" title="Live watching arrives with the stage-3 parity build (#426)" aria-disabled="true" className="off">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
          <path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" opacity=".55" />
        </svg>
      </button>
      <div className="grow" />
      <ThemeToggle />
    </div>
  );
}
