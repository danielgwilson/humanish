import { GITHUB, NODE_FLOOR } from "@/lib/site-data";

/** The questions the personas asked on the site study, answered with what the docs state; each links the page that backs it. */
const ITEMS = [
  {
    q: "What does a run cost?",
    a: (
      <>
        The TodoMVC example cost about $0.16 in model spend per run, measured on September 1, 2026,
        plus a few cents of desktop time, plus the analysis step if you leave it on. You set a cap
        in the lab file and the run stops when its estimate reaches it. The cap works on
        humanish&rsquo;s estimate at dated rates; your provider&rsquo;s bill is the real number.
      </>
    ),
    link: { href: "/docs/what-a-study-costs", label: "What a study costs, with measured numbers" },
  },
  {
    q: "What do I need to run one?",
    a: (
      <>
        Node {NODE_FLOOR} or newer, an OpenAI API key, and an E2B key for the hosted desktop. If you
        are signed in to Codex or Claude Code, that can drive the participant instead of an OpenAI
        key. You still need E2B.
      </>
    ),
    link: { href: "/docs", label: "Setup for each option" },
  },
  {
    q: "What do lab, bundle and Observer mean?",
    a: (
      <>
        A lab is the YAML file that says which app, which persona and which task. A bundle is the
        folder a run writes under <code>.humanish/runs/</code>, with the captures, actions,
        reasoning, findings and cost. The Observer is the viewer that replays a bundle in your
        browser; <code>npx humanish watch</code> opens it.
      </>
    ),
    link: { href: "/docs/study-files", label: "Study files" },
  },
  {
    q: "Where does the evidence go, and who sees it?",
    a: (
      <>
        It stays in your repo under <code>.humanish/runs/</code>, which is gitignored. humanish
        uploads nothing. The model provider sees what the participant sees, and if you run analysis,
        that step sends selected text and captures to the model you pick. Telemetry is anonymous
        command usage, and <code>npx humanish telemetry disable</code> turns it off.
      </>
    ),
    link: { href: "/docs/trust-boundaries", label: "Who sees what, and the threat model" },
  },
  {
    q: "How is this different from a Playwright test?",
    a: (
      <>
        A test checks the steps you wrote down. A participant gets a persona and a goal, works out
        the steps itself, and the trace records each action and what it was thinking before it. That
        is how you see where someone hesitated or gave up.
      </>
    ),
    link: { href: "/docs/read-results", label: "How to read a run" },
  },
  {
    q: "What is it not for?",
    a: (
      <>
        Load testing, security testing, or pixel-exact regression. It is also no substitute for
        watching a real user: a synthetic participant tells you where one person got stuck, and
        nothing about how many of your users would.
      </>
    ),
    link: { href: "/failure-modes", label: "Known failure modes" },
  },
  {
    q: "Why does this exist?",
    a: (
      <>
        humanish started on a chat-based patient intake. Testing one long flow meant recruiting five
        ADHD patients, paying a panel, and waiting days for notes on one screen. Recruit real users
        whenever you can. humanish is for the studies you would otherwise skip.
      </>
    ),
    link: { href: GITHUB, label: "The repository" },
  },
];

export default function Faq() {
  return (
    <section className="band faq" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="rev">
        FAQ
      </h2>
      <dl className="faq-list">
        {ITEMS.map((item) => (
          <div className="faq-item rev" key={item.q}>
            <dt>{item.q}</dt>
            <dd>
              <p>{item.a}</p>
              <a
                className="faq-link"
                href={item.link.href}
                {...(item.link.href.startsWith("http") ? { rel: "noopener" } : {})}
              >
                {item.link.label} →
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
