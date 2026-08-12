import { Wordmark } from "./wordmark";

// Rendered when the artifact carries no inlined snapshot (placeholder untouched or
// malformed). Says what happened and how a real one gets its data — never a blank page.
export function EmptyState() {
  return (
    <div className="empty">
      <Wordmark label="humanish Observer" />
      <span className="o-label">Observer</span>
      <p>
        This artifact was opened without run data. The humanish CLI injects a run&rsquo;s
        <code> observer-data.v1</code> snapshot when it writes <code>observer/index.html</code> —
        open a run through <code>humanish observe</code> or <code>humanish watch</code>.
      </p>
    </div>
  );
}
