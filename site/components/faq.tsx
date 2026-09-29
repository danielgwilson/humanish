import { GITHUB } from "@/lib/site-data";

/** The questions the personas asked on the site study, answered with what the docs state; each links the page that backs it. */
const ITEMS = [
  {
    q: "What does a run cost?",
    a: <>About $0.16 in model spend for the TodoMVC edit study (three fresh installs, September 1, 2026), plus E2B desktop minutes, plus analysis if you run it. A lab&apos;s <code>maxUsd</code> stops a run when the estimate reaches it; it is an estimate at dated rates, not a provider billing limit.</>,
    link: { href: "/docs/what-a-study-costs", label: "What a study costs, with measured numbers" }
  },
  {
    q: "What do I need to run one?",
    a: <>Node 20 or newer, an OpenAI API key and an E2B key for the hosted desktop. The local-agent route lets your signed-in Codex or Claude Code drive instead.</>,
    link: { href: "/docs", label: "What each route needs" }
  },
  {
    q: "What do lab, bundle and Observer mean?",
    a: <>A lab is the YAML file that names the app, the persona and the task. A bundle is the folder a run writes under <code>.humanish/runs/</code>: captures, actions, reasoning, findings and cost. The Observer is the local viewer that replays a bundle; <code>npx humanish watch</code> opens it.</>,
    link: { href: "/docs/lab-manifests", label: "Lab manifests" }
  },
  {
    q: "Where does the evidence go, and who sees it?",
    a: <>Into your repo under <code>.humanish/runs/</code>. humanish uploads nothing; the model provider you chose sees what the participant sees, and <code>humanish analyze</code> sends selected text and captures to the analyst you name. Telemetry is anonymous command usage and <code>npx humanish telemetry disable</code> turns it off.</>,
    link: { href: "/docs/trust-boundaries", label: "Who sees what, and the threat model" }
  },
  {
    q: "How is this different from a Playwright test?",
    a: <>A script asserts the path you wrote. A participant gets a goal and a persona, picks its own path, and the trace records every action and what it was thinking before each one, so you see where it hesitated or stopped.</>,
    link: { href: "/docs/read-results", label: "How to read a run" }
  },
  {
    q: "What is it not for?",
    a: <>Load, security or pixel-exact regression testing, and it supplements real-user research rather than replacing it. Synthetic participants give you directional evidence, not rates for your users.</>,
    link: { href: "/failure-modes", label: "What it cannot tell you" }
  },
  {
    q: "Why does this exist?",
    a: <>humanish started on a chat-based patient intake. Testing one long flow meant recruiting five ADHD patients, paying a panel, and waiting days for notes on one screen. When you can recruit real users, do it. humanish covers the runs that otherwise never happen.</>,
    link: { href: GITHUB, label: "The repository" }
  }
];

export default function Faq() {
  return (
    <section className="band faq" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="rev">FAQ</h2>
      <dl className="faq-list">
        {ITEMS.map((item) => (
          <div className="faq-item rev" key={item.q}>
            <dt>{item.q}</dt>
            <dd><p>{item.a}</p><a className="faq-link" href={item.link.href} {...(item.link.href.startsWith("http") ? { rel: "noopener" } : {})}>{item.link.label} →</a></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
