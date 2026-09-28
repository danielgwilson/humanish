import { GITHUB } from "@/lib/site-data";

/** The questions the skeptic and newcomer personas asked on the last site study, answered with what the docs state. */
const ITEMS = [
  {
    q: "What does a run cost?",
    a: <>Three things, each on your own account. Model spend: three fresh installs measured on September 1, 2026 finished the TodoMVC edit study in 108 to 111 seconds at about $0.16 per run. Desktop time: E2B bills the hosted desktop by the minute. Analysis: <code>humanish analyze</code> is a separate call with its own estimate and ceiling. A lab&apos;s <code>maxUsd</code> stops a run when the estimate reaches it; it is an estimate at dated rates, not a provider billing limit, and every bundle records what it came to. <a href="/docs/budgets-and-privacy">How budgets work</a></>
  },
  {
    q: "What do I need to run one?",
    a: <>An OpenAI API key and an E2B key for the hosted desktop. The local-agent route lets your signed-in Codex or Claude Code drive instead. <a href="/docs">What each route needs</a></>
  },
  {
    q: "Where does the evidence go?",
    a: <>Into your repo under <code>.humanish/runs/</code>: captures, the action trace, the event log, the review, the cost. humanish itself uploads nothing; the model provider you chose sees what the participant sees, and <code>humanish analyze</code> sends selected text and captures to the analyst you name. Telemetry is anonymous command usage, never labs, subjects or personas; <a href={`${GITHUB}/blob/main/TELEMETRY.md`} rel="noopener">the telemetry document</a> lists every field, and <code>npx humanish telemetry disable</code> turns it off. <a href="/docs/budgets-and-privacy">Budgets and privacy</a></>
  },
  {
    q: "Is it open source?",
    a: <>Yes. MIT, <a href={GITHUB} rel="noopener">on GitHub</a>, and on npm as <code>humanish</code>.</>
  },
  {
    q: "What is it not for?",
    a: <>Load, security or pixel-exact regression testing, and it supplements real-user research rather than replacing it. <a href="#trust">The section above</a> lists four things it never does with your keys and evidence.</>
  }
];

export default function Faq() {
  return (
    <section className="band faq" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="rev">Answers to what people ask before they try it</h2>
      <dl className="faq-list">
        {ITEMS.map((item, i) => (
          <div className="faq-item rev" key={item.q} style={{ "--d": `${0.04 * i}s` } as React.CSSProperties}>
            <dt>{item.q}</dt>
            <dd>{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
