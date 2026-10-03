import { NODE_FLOOR } from "@/lib/site-data";

export default function Commands() {
  return (
    <section id="commands" className="band">
      <h2 className="rev">
        Run your first study with <em>one command</em>
      </h2>
      <p className="sec-sub rev" style={{ "--d": ".06s" } as React.CSSProperties}>
        <code>humanish init</code> writes a study file: who the participant is, what they are trying
        to do, and where your app is, a repo to clone or a URL you own. <code>humanish run</code>{" "}
        does the rest. The other three commands are what you do with what comes back. They need Node{" "}
        {NODE_FLOOR} or newer; a live run reads <code>OPENAI_API_KEY</code> and{" "}
        <code>E2B_API_KEY</code> from your environment, or drives your signed-in Codex or Claude
        Code instead.
      </p>

      <div className="cmd-ledger rev" style={{ "--d": ".12s" } as React.CSSProperties}>
        <div className="cmd-row">
          <code>humanish init</code>
          <p>
            Write the study: the participant, the task, your app. <code>--yes</code> takes the
            defaults.
          </p>
        </div>
        <div className="cmd-row">
          <code>{"humanish run <study>"}</code>
          <p>
            The one command. A hosted desktop, a real browser, your app cloned and built if it is a
            repo, the participant at work, everything recorded to <code>.humanish/runs/</code>.{" "}
            <code>watch</code> in place of <code>run</code> keeps the Observer open while it
            happens.
          </p>
        </div>
        <div className="cmd-row">
          <code>humanish analyze</code>
          <p>
            Ranked findings, each linked to the moment and the capture behind it. Runs by default
            after a live study under its own disclosed budget; <code>review.analysis: false</code>{" "}
            turns it off.
          </p>
        </div>
        <div className="cmd-row">
          <code>humanish verify</code>
          <p>
            Grades the evidence for sharing and fails closed: <code>share_ready</code>,{" "}
            <code>local_only</code> or <code>blocked</code>.
          </p>
        </div>
        <div className="cmd-row">
          <code>humanish feedback issue</code>
          <p>Turns a finding into a GitHub issue draft. Nothing is posted.</p>
        </div>
      </div>
      <p className="cmd-note rev" style={{ "--d": ".18s" } as React.CSSProperties}>
        <span>
          <code>humanish watch</code> with no study plays a bundled sample study in the Observer: no
          keys, no spend, and it never opens your app.
        </span>
      </p>
    </section>
  );
}
