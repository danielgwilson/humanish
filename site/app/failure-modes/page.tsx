import type { Metadata } from "next";
import Footer from "@/components/footer";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";

const GITHUB = "https://github.com/danielgwilson/humanish";
const issueHref = (n: number) => `${GITHUB}/issues/${n}`;
const arxivHref = (id: string) => `https://arxiv.org/abs/${id}`;

/**
 * Inline citation: "(OSWorld 2.0, arXiv:2606.29537)" with the id linked.
 * Each run of text is a single JSX expression on purpose: adjacent text nodes
 * make React emit `<!-- -->` separators, which split the citation for anything
 * reading the page as text (the site's audience includes agents).
 */
function Cite({ work, id }: { work?: string; id: string }) {
  return (
    <span className="cite">
      {`(${work ? `${work}, ` : ""}`}
      <a href={arxivHref(id)} rel="noopener">{`arXiv:${id}`}</a>
      {")"}
    </span>
  );
}

/** Inline issue reference, linked to the public tracker. */
function Issue({ n }: { n: number }) {
  return (
    <a href={issueHref(n)} rel="noopener">{`danielgwilson/humanish#${n}`}</a>
  );
}

const TITLE = "humanish — known failure modes";
const DESCRIPTION =
  "humanish ships evidence as the product, so it owes you the error bars on that evidence: what the computer-use substrate cannot do yet, where simulated users diverge from real ones, what a passing humanish verify grade does not prove, and when to go recruit people instead.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/failure-modes" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/failure-modes",
    siteName: "humanish",
    type: "article"
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION
  }
};

export default function FailureModes() {
  return (
    <>
      <Nav base="/" />
      <main>
        <section className="band">
          <h1 className="rev">Known <em>failure modes</em></h1>
          <div className="fm-prose">
            <p className="sec-sub rev" style={{ "--d": ".06s" } as React.CSSProperties}>humanish ships evidence as the product, so it owes you the error bars on that evidence. This page states four things: what the computer-use substrate cannot do yet, where simulated users diverge from real ones, what a passing <code>humanish verify</code> grade does not prove, and when to go recruit people instead.</p>
            <p className="sec-sub rev" style={{ "--d": ".1s" } as React.CSSProperties}>The published numbers against simulation are cited here first, before a skeptic gets to use them. The first-party failures are our own runs, and the ids are quotable.</p>
          </div>
        </section>

        <section id="substrate" className="band band-mineral">
          <h2 className="rev">What the substrate <em>can&rsquo;t</em> do yet</h2>
          <div className="fm-prose">
            <p className="sec-sub rev" style={{ "--d": ".05s" } as React.CSSProperties}>Computer-use agents are good at short bounded interface work and bad at long workflows. OSWorld 2.0 benchmarks 108 long-horizon real workflows with a median human completion time of about 1.6 hours. The best model measured, Claude Opus 4.8 with maximum thinking and batched tool calls, &ldquo;completes only 20.6% of tasks at a 54.8% partial score&rdquo;; GPT-5.5 &ldquo;plateaus near 13%&rdquo; <Cite work="OSWorld 2.0" id="2606.29537" />. A single task averaged 318 tool calls under Claude Opus 4.7 at maximum thinking.</p>
            <p className="sec-sub rev" style={{ "--d": ".08s" } as React.CSSProperties}>The shape of the failure matters as much as the rate. From the same abstract, verbatim: &ldquo;Rather than stumbling on basic GUI control or coding, they lose track of constraints, miss information that arrives mid-task, guess rather than ask the user, and skip verification, struggling most when a task hinges on hidden state they must recover&rdquo; <Cite id="2606.29537" />. Clicking, typing, and reading a screen mostly work. Holding a multi-hour goal does not.</p>
          </div>

          <h3 className="fm-sub rev">What humanish does about it</h3>
          <div className="fm-prose">
            <p className="sec-sub rev"><b>Missions are bounded and the clock is published.</b> The Excalidraw study ran four lanes to completion in 6m 06s wall-clock at ~$1.54 estimated (run <code>cua-2026-08-07T17-44-48-760Z-87389419</code>, rates as of 2026-08-05). Nothing in the shipped labs asks an actor to hold an hour-plus goal, because the benchmark above says it would fail about four times in five.</p>
            <p className="sec-sub rev"><b>A stalled lane records why it stopped and fails.</b> <code>humanish</code> trips a backstop after N consecutive turns with no change to the UI state and writes the reason into the bundle verbatim. In the Excalidraw study, lane 03 <code>sketch-shapes</code> recorded &ldquo;gave up: 8 consecutive turns with no change to the UI state&rdquo;, and the study publishes as 3/4 rather than 4/4.</p>
            <p className="sec-sub rev"><b>Our own site study lost half its lanes to this.</b> Four cold-visitor lanes ran against the live humanish.dev on 2026-08-08:</p>
          </div>

          <dl className="manifest rev">
            <div><dt>Study</dt><dd>humanish.dev · cold visitors</dd></div>
            <div><dt>Date</dt><dd>2026-08-08</dd></div>
            <div><dt>Lanes</dt><dd>2/4 passed</dd></div>
            <div><dt>Verify</dt><dd>16/16 checks</dd></div>
            <div><dt>Est. cost</dt><dd>~$3.57 · estimated (rates as of 2026-08-05)</dd></div>
            <div><dt>Dead lanes</dt><dd>~$1.91 of ~$3.57</dd></div>
          </dl>

          <div className="ledger fm-ledger rev">
            <div className="lh"><span>Lane · persona</span><span>Outcome · run</span></div>
            <div className="lrow">
              <span className="ln"><em>first-look</em> skeptical-power-user</span>
              <span className="ld">pass · cua-2026-08-08T21-31-34-600Z-94f92b0b</span>
            </div>
            <div className="lrow">
              <span className="ln"><em>get-started</em> pragmatic-integrator</span>
              <span className="ld">pass · cua-2026-08-08T21-32-56-698Z-e38c1ba7</span>
            </div>
            <div className="lrow">
              <span className="ln"><em>study-read</em> evidence-reader</span>
              <span className="ld">gave up: 8 consecutive turns with no change to the UI state · cua-2026-08-08T21-34-20-304Z-f6faa730</span>
            </div>
            <div className="lrow">
              <span className="ln"><em>full-sweep</em> tool-scout</span>
              <span className="ld">gave up: 8 consecutive turns with no change to the UI state · cua-2026-08-08T21-35-31-308Z-1e77fa09</span>
            </div>
          </div>

          <div className="fm-prose">
            <p className="sec-sub rev">Both dead lanes died on our own page. Inside the scroll-pinned replay section, a scroll that doesn&rsquo;t cross a step threshold changes nothing visually, so eight small scrolls produce eight identical screenshots and the staleness guard concludes the lane is spinning. The screenshots show the actor had stepped several panels before it stalled, so it was making progress in the page&rsquo;s own terms. Filed as <Issue n={393} />: the guard should include scroll position in the state fingerprint. The two dead lanes account for ~$1.91 of the study&rsquo;s ~$3.57 estimated total.</p>
            <p className="sec-sub rev">That finding cuts against us twice. The guard is our own heuristic, and the page it broke on is our own marketing surface.</p>
          </div>
        </section>

        <section id="simulated" className="band">
          <h2 className="rev">What simulated users get <em>wrong</em></h2>

          <h3 className="fm-sub rev"><span className="fm-idx">2.1</span>A model&rsquo;s clicks are not a population&rsquo;s clicks</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Twelve first-click tests drawn from real UX practice, n = 3,431 real participants: GPT produced a &ldquo;significantly different distribution from real data in 53% of tasks.&rdquo; Personas, chain-of-thought, and sampling changes &ldquo;fail to create sensible fidelity improvements apart from inflating believability&rdquo; <Cite work="What Would GPT Click" id="2605.18302" />.</p>
            <p className="sec-sub rev">That last clause is the sharpest published line against persona prompting, and it applies to humanish&rsquo;s own persona blocks. Adding a persona description makes output read more plausibly without making it more accurate.</p>
            <p className="sec-sub rev"><b>What humanish does:</b> lanes do not predict clicks. A lane executes a declared mission in a real browser on a hosted desktop, and the bundle records the actions taken, the screenshots seen, and the outcome. humanish publishes no click-distribution claim and no population match. Our own design notes concede the harder version of this: at the kinematic level of pointer paths, timing, and motor noise, the gap between agents and people is total and trivially detectable <Cite id="2604.09574" />, and fidelity here is scoped to which affordances an actor used, not to behavioral realism.</p>
          </div>

          <h3 className="fm-sub rev"><span className="fm-idx">2.2</span>The result depends on which model plays the user, and it is worst for the users you can least recruit</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Agent success rates vary &ldquo;up to 9 percentage points across different user LLMs.&rdquo; Evaluations with simulated users &ldquo;exhibit systematic miscalibration, underestimating agent performance on challenging tasks and overestimating it on moderately difficult ones.&rdquo; Simulated users are &ldquo;a differentially effective proxy for different populations, performing worst for AAVE and Indian English speakers,&rdquo; with AAVE speakers seeing &ldquo;consistently worse success rates and calibration errors&rdquo; than Standard American English speakers <Cite work="Lost in Simulation, ACL 2026" id="2601.17087" />.</p>
            <p className="sec-sub rev">Plainly: this lands on humanish&rsquo;s own framing. The site says &ldquo;user testing for the users you can&rsquo;t recruit.&rdquo; The populations that are hardest to recruit are the ones this literature simulates worst, which makes the hardest case for humanish also the weakest case. A humanish persona is an authored YAML description, not an interview-grounded twin of a real person, and nothing in the harness measures how close it lands.</p>
            <p className="sec-sub rev"><b>What humanish does:</b> the actor and model are recorded in every bundle. The four self-study lanes above ran <code>openai-responses-cu</code> on <code>gpt-5.5</code>; swapping that model would move the results by an amount we have not measured and do not claim to know. humanish makes no representativeness claim and emits no segment comparison. That last omission is deliberate. Across the General Social Survey and the World Values Survey, LLM synthetic respondents &ldquo;inflate between-segment gaps two to fourfold&rdquo; and &ldquo;would direct a team to the wrong segment in half of U.S. and most cross-cultural cases,&rdquo; and at the individual level &ldquo;no LLM beats even the strongest baseline&rdquo; <Cite work="When Synthetic Users Fail" id="2607.26348" />. There is no survey path in humanish, and there is no demographic-segment output.</p>
          </div>

          <h3 className="fm-sub rev"><span className="fm-idx">2.3</span>A persona&rsquo;s opinion is the least trustworthy thing in the bundle</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Across 11 models, LLMs &ldquo;preserve user&rsquo;s face 45 percentage points more than humans in general advice queries and in queries describing clear user wrongdoing,&rdquo; and when given either side of a moral conflict they affirm both sides in 48% of cases <Cite work="ELEPHANT" id="2505.13995" />. A model asked whether a product is good will tend toward yes.</p>
            <p className="sec-sub rev"><b>What humanish does:</b> reports ship verbatim and sit next to the trace that produced them, so the words can be checked against the actions. The Excalidraw study&rsquo;s three passing lanes reported, in full, &ldquo;Done&rdquo;, &ldquo;Done.&rdquo; and &ldquo;Done&rdquo; &mdash; worth nearly nothing on their own, which is the reason they are published beside 28 screenshots, ordered action traces, and lifecycle events rather than as a testimonial. humanish does not ask personas to rate, score, or recommend the product.</p>
          </div>

          <h3 className="fm-sub rev"><span className="fm-idx">2.4</span>A cooperative simulator will tell you your product works</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Grounding simulators in 14,000+ real human-LLM conversations, RealUserSim finds that grounded simulation &ldquo;acts as a realistic stress test, surfacing three failure mechanisms invisible to cooperative simulators (mean -3.2% to -3.5% task success degradation)&rdquo; <Cite id="2605.20204" />. Realistic users make a product look worse, which means a happy-path demo is evidence of a compliant simulator.</p>
            <p className="sec-sub rev"><b>What humanish does:</b> failed lanes are published at the same weight as passing ones. The Excalidraw study ships as 3/4. The self-study ships as 2/4. Neither number was tuned up before publication.</p>
          </div>
        </section>

        <section id="evidence" className="band band-mineral">
          <h2 className="rev">What the evidence layer does and does not <em>guarantee</em></h2>

          <h3 className="fm-sub rev">What <code>humanish verify</code> checks</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Mechanical properties of the bundle. Run storage containment, run schema and bundle shape, redaction, a public-safety scan, actor engagement, actor verdict consistency, subject state provenance, cleanup receipt, rerun lineage, and cost-estimate labeling, among others. The Excalidraw study and the self-study each passed 16/16 on their runs.</p>
            <p className="sec-sub rev">Share-safety grades fail closed: a bundle grades <code>share_ready</code>, <code>local_only</code>, or <code>blocked</code>, and a bundle that cannot pass every gate never grades <code>share_ready</code>. Both published studies graded <code>local_only</code>, because they hold full-fidelity screenshots. Publishing the crops on the study page was a separate, reviewed act by a human.</p>
          </div>

          <h3 className="fm-sub rev">That gate binds the operator too, on camera</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">During the self-study, <code>humanish feedback issue</code> refused to draft from the <code>local_only</code> bundle with <code>HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED</code>. The share-ready re-run (<code>redactScreenshots: true</code>, run <code>cua-2026-08-08T21-39-07-933Z-56b68f47</code>) graded <code>share_ready</code> at 16/16 and produced a draft. The draft was wrong. Its <code>actual</code> field read &ldquo;This dry-run produced a contract-proof bundle only; no browser or product behavior was exercised&rdquo; &mdash; on a live run with 15 redacted screenshots and a real action trace. The lane&rsquo;s own outcome, its gave-up reason, the subject URL, and the screenshot counts appear nowhere in the draft. Filed as <Issue n={392} />. The share-safety gate worked. The drafter did not. Until #392 closes, read the bundle, not the draft.</p>
          </div>

          <h3 className="fm-sub rev">What verify does not check</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Verify has no opinion on whether a finding is true, whether the mission was worth running, or whether the persona behaved like a person would. It checks that the instrument reported honestly about itself. A green lane is a lane that ran and reported, and nothing further.</p>
            <p className="sec-sub rev">Outcome-only scoring is known to be blind to how a result was reached. WebArena&rsquo;s URL evaluator scores on the final page URL, so a single <code>goto</code> to the reference URL earns full credit <Cite id="2307.13854" />. &tau;-bench states the general form: a state-based reward is necessary but not sufficient, because it cannot see whether policy was followed <Cite id="2406.12045" />. And the gradient is real, since calling site APIs instead of driving the UI roughly doubles WebArena scores <Cite id="2410.16464" />. humanish&rsquo;s answer is to record which affordance class each action used and leave the verdict open, rather than to bake one in.</p>
          </div>

          <h3 className="fm-sub rev">Judgment is the adopter&rsquo;s seam</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Product semantics belong in the adopter&rsquo;s repo. A lab manifest can declare <code>review.scorer.ref</code> (or pass <code>--scorer &lt;path&gt;</code>) to load adopter-defined scoring against the full trace. The design position, verbatim from humanish&rsquo;s own actor-fidelity notes: &ldquo;The harness emits facts; the adopter decides what they mean.&rdquo;</p>
            <p className="sec-sub rev">The field is converging on the same premise. A 2026 survey of evidence tracing and execution provenance in LLM agents opens on the reason: &ldquo;Final-answer accuracy alone cannot explain how an output was produced, which evidence supported each claim, whether tool calls were justified, how memory influenced later decisions, or where failures originated&rdquo; <Cite id="2606.04990" />. Whether a model can write a <em>useful</em> UX critique is separately unsettled: across eight frontier models, &ldquo;UX judging is neither saturated nor one dimensional&rdquo; <Cite work="UXBench" id="2606.16262" />.</p>
          </div>

          <h3 className="fm-sub rev">Cost numbers are estimates</h3>
          <div className="fm-prose">
            <p className="sec-sub rev">Every cost in a bundle is labeled <code>fullyEstimated</code> with a <code>ratesAsOf</code> date. The self-study&rsquo;s ~$3.57 and the Excalidraw study&rsquo;s ~$1.54 are estimates at 2026-08-05 rates, not invoices.</p>
          </div>
        </section>

        <section id="recruit" className="band band-dark">
          <h2 className="rev">When to recruit <em>real users</em> instead</h2>
          <blockquote className="lead-claim rev" style={{ maxWidth: "44ch" }}>When you can recruit real users, do that. humanish covers the runs that otherwise never happen.</blockquote>
          <p className="sec-sub rev">That line is on the front page and it is the honest boundary. Cases where humanish is the wrong instrument:</p>

          <div className="cmd-ledger rev">
            <div className="cmd-row">
              <b>Any claim about how a population actually behaves.</b>
              <p>GPT&rsquo;s click distribution differed significantly from 3,431 real people in 53% of tasks <Cite id="2605.18302" />, and agent success moves up to 9 percentage points on the choice of user model alone <Cite id="2601.17087" />.</p>
            </div>
            <div className="cmd-row">
              <b>Anything about feeling.</b>
              <p>Frustration, delight, hesitation, and trust do not appear in a bundle. There is no field for them because there is no measurement behind them.</p>
            </div>
            <div className="cmd-row">
              <b>Segment and demographic comparison.</b>
              <p>Models inflate between-segment gaps two to fourfold and pick the wrong segment in half of U.S. cases <Cite id="2607.26348" />. humanish emits no segment output.</p>
            </div>
            <div className="cmd-row">
              <b>Long realistic workflows.</b>
              <p>The best model completes 20.6% of hour-plus workflows <Cite id="2606.29537" />. Scope missions accordingly.</p>
            </div>
            <div className="cmd-row">
              <b>Accessibility conclusions.</b>
              <p>Lanes drive a standard desktop browser at 1920&times;1080 and record no assistive-technology path.</p>
            </div>
          </div>

          <p className="sec-sub fm-after-ledger rev">What is left is real and narrower: driving the build you have, right now, on runs that would otherwise not happen, and getting back a durable bundle whose failures are visible.</p>

          <div className="origin" id="caveats">
            <h2 className="rev">Standing <em>caveats</em></h2>
            <div className="fm-prose fm-prose-flush">
              <p className="sec-sub rev">These numbers are current as of 2026-08-08. OSWorld 2.0 results in particular will move.</p>
              <p className="sec-sub rev">The behavioral class of simulated-user research is under-validated rather than validated. Treat humanish output as early, directional evidence and as hypothesis generation. It is not a substitute for recruiting the people it stands in for.</p>
              <p className="sec-sub rev">Anything on this page that turns out to be wrong is a bug. Open an issue with the run id.</p>
            </div>
          </div>
        </section>
      </main>
      <Footer base="/" />
      <Reveals />
    </>
  );
}
