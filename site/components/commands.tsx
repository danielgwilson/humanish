export default function Commands() {
  return (
    <section id="commands" className="band">
      <h2 className="rev">Run a study in <em>five commands</em></h2>
      <p className="sec-sub rev" style={{ "--d": ".06s" } as React.CSSProperties}>Subagents critique your code. Personas use your app. These five commands take a lab from a blank repo to a filed issue. They need Node 20 or newer; a live run reads <code>OPENAI_API_KEY</code> and <code>E2B_API_KEY</code> from your environment, or drives your signed-in Codex or Claude Code instead.</p>

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
      <p className="cmd-note rev" style={{ "--d": ".18s" } as React.CSSProperties}><span><code>humanish watch</code> with no lab argument renders a synthetic evidence bundle and Observer locally, without keys or provider spend.</span></p>
    </section>
  );
}
