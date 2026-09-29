import { GITHUB } from "@/lib/site-data";

/** The last band: one concrete ask, the three commands it takes, and the two facts that matter (cap, license). */
export default function Closer() {
  return (
    <section className="band band-dark closer" id="try">
      <h2 className="rev">Try it on your app with <em>one participant</em></h2>
      <div className="cta-row rev" style={{ "--d": ".08s" } as React.CSSProperties}>
        <a className="btn btn-primary" href="/docs">Run your first study</a>
        <a className="btn btn-ghost" href={GITHUB}>View on GitHub</a>
      </div>
      <pre className="cmdline rev" style={{ "--d": ".14s" } as React.CSSProperties}><code>npm i -D humanish @e2b/desktop</code>
<code>npx humanish init --yes</code>
<code>npx humanish run try-live</code></pre>
      <p className="closer-note rev" style={{ "--d": ".2s" } as React.CSSProperties}>One participant, a real app, about two minutes, capped at $2 of estimated model spend. MIT.</p>
    </section>
  );
}
