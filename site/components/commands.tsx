export default function Commands() {
  return (
    <section id="commands" className="band">
      <h2 className="rev">Subagents critique your code.<br />Personas <em>use</em> your app.</h2>
      <p className="sec-sub rev" style={{ "--d": ".06s" } as React.CSSProperties}>You already run subagents against your code. These five commands do the same for the app you publish: personas and missions declared in a YAML lab, one evidence bundle per run.</p>

      <div className="cmd-ledger rev" style={{ "--d": ".12s" } as React.CSSProperties}>
        <div className="cmd-row">
          <code>humanish init</code>
          <p>Create a lab in YAML: personas, missions, and the app under test, either a repo to clone or a URL you own. <code>--yes</code> takes the defaults.</p>
        </div>
        <div className="cmd-row">
          <code>{"humanish watch <lab>"}</code>
          <p>Run a live lab on hosted sandbox desktops. With a clone-based lab, your app does not need to be deployed or already running: the sandbox clones your repo, builds it, and serves it. Watch live in Observer; replay any lane after.</p>
        </div>
        <div className="cmd-row">
          <code>humanish analyze</code>
          <p>Ranked findings with links to the exact events and captures behind each one. Runs by default after a supported live study under a separate, disclosed budget; <code>review.analysis: false</code> turns it off.</p>
        </div>
        <div className="cmd-row">
          <code>humanish verify</code>
          <p>Check the bundle against the public-safety gates and fail closed: <code>share_ready</code>, <code>local_only</code>, or <code>blocked</code>.</p>
        </div>
        <div className="cmd-row">
          <code>humanish feedback issue</code>
          <p>Render a public-safe GitHub issue draft from the bundle.</p>
        </div>
      </div>
      {/* Prerequisites, because two persona studies stopped here to ask for them:
          a required Node/npm version, and whether keys are needed before watch.
          Node from the package's own engines field (">=20"); the two key names
          from what a live run actually reads (README "Live runs" + src/lab-preflight.ts).
          It leads the notes so the keyless local run still closes the band. */}
      <p className="cmd-note rev"><span>All five commands need Node 20 or newer. Hosted desktops also read <code>OPENAI_API_KEY</code> and <code>E2B_API_KEY</code> from your environment.</span></p>
      <p className="cmd-note rev" style={{ "--d": ".18s" } as React.CSSProperties}><span><code>humanish watch</code> with no lab argument renders a synthetic evidence bundle and Observer locally, without keys or provider spend.</span></p>
    </section>
  );
}
