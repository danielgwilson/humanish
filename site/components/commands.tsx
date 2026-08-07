export default function Commands() {
  return (
    <section id="commands" className="band">
      <h2 className="rev">Subagents critique your code.<br />Personas <em>use</em> your app.</h2>
      <p className="sec-sub rev" style={{ "--d": ".06s" } as React.CSSProperties}>You already run subagents against your code. humanish is the same pattern: declare personas and missions in a YAML lab, run four commands, read the evidence bundle.</p>

      <div className="cmd-ledger rev" style={{ "--d": ".12s" } as React.CSSProperties}>
        <div className="cmd-row">
          <code>humanish init</code>
          <p>Scaffold a lab: personas, missions, and target app in YAML. <code>--yes</code> takes the defaults.</p>
        </div>
        <div className="cmd-row">
          <code>humanish watch</code>
          <p>Run every lane on hosted sandbox desktops. Watch live in Observer; replay any lane after.</p>
        </div>
        <div className="cmd-row">
          <code>humanish verify</code>
          <p>Grade the bundle against public-safety gates, fail-closed: <code>share_ready</code>, <code>local_only</code>, or <code>blocked</code>.</p>
        </div>
        <div className="cmd-row">
          <code>humanish feedback issue</code>
          <p>Render a public-safe GitHub issue draft from the bundle.</p>
        </div>
      </div>
      <p className="cmd-note rev" style={{ "--d": ".18s" } as React.CSSProperties}>No staging URL? The sandbox clones your repo, builds it, and serves it.</p>
    </section>
  );
}
