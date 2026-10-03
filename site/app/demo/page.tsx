import type { Metadata } from "next";
import Footer from "@/components/footer";
import HeroObserver from "@/components/hero-observer";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";

const TITLE = "Watch eight synthetic participants use one app at the same time";
const DESCRIPTION =
  "A saved humanish run, replayed in the real Observer: eight participants in one lobby of a multiplayer game on its live deployment, six reached the final standings, two were blocked, seven findings.";

export const metadata: Metadata = {
  title: `humanish — ${TITLE}`,
  description: DESCRIPTION,
  alternates: { canonical: "https://humanish.dev/demo" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://humanish.dev/demo",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

/** Findings as `humanish analyze` wrote them into the bundle, paraphrased to one line each; the artifact carries the full text and the evidence links. */
const FINDINGS = [
  {
    id: "F1",
    impact: "Blocked",
    text: "Keyboard guessing was hard to track; one keyboard-only participant stopped in round 3 with focus stuck in the browser toolbar.",
  },
  {
    id: "F2",
    impact: "Blocked",
    text: "A participant who joined after the host pressed Start was told to wait for the game to end, with no sign of when that would be.",
  },
  {
    id: "F3",
    impact: "Friction",
    text: "Finding and verifying a film in the picker was uncertain; one participant fell back to browser Find.",
  },
  {
    id: "F4",
    impact: "Recovery",
    text: "The lobby code landed in the display-name field first; the participant blamed the focus order and corrected it.",
  },
  {
    id: "F5",
    impact: "Friction",
    text: "A confirmation briefly showed the category label instead of the chosen title.",
  },
  {
    id: "F6",
    impact: "Friction",
    text: "The host questioned a 74-second wait after locking in an answer.",
  },
  {
    id: "F7",
    impact: "Friction",
    text: "The host saw a stale round label during a transition and raised it again in the closing report.",
  },
];

/** The saved run, full width, with the numbers and findings that came out of it. Nothing runs from this page. */
export default function Demo() {
  return (
    <>
      <Nav base="/" />
      <main id="main" className="demo">
        <section className="band demo-head">
          <p className="kicker">
            Saved run · 2026-09-27 · replayed in the Observer, nothing runs from this page
          </p>
          <h1>{TITLE}</h1>
          <p className="lede">
            The host created a lobby of a multiplayer movie-guessing game on its live deployment.
            Seven more participants joined through the real Join flow on their own hosted desktops
            and played five rounds. Six reached the final standings. Two were blocked, and{" "}
            <code>humanish analyze</code> turned the recording into seven findings, each linked to
            the capture that backs it.
          </p>
          <div className="manifest">
            <div>
              <span className="fl">Participants</span>
              <b>8</b>
            </div>
            <div>
              <span className="fl">Desktops</span>
              <b>8, one each</b>
            </div>
            <div>
              <span className="fl">Wall clock</span>
              <b>13 min</b>
            </div>
            <div>
              <span className="fl">Captures</span>
              <b>506</b>
            </div>
            <div>
              <span className="fl">Reached the goal</span>
              <b>6 of 8</b>
            </div>
            <div>
              <span className="fl">Findings</span>
              <b>7</b>
            </div>
            <div>
              <span className="fl">Analysis cost</span>
              <b>$2.29</b>
            </div>
          </div>
        </section>
        <section className="band demo-stage">
          <HeroObserver
            slug="lobby-0927"
            participants={8}
            title="Eight participants in one lobby of a multiplayer movie-guessing game"
          />
          <p className="demo-hint">
            Click the frame to expand it. Inside, press play, open a participant, or switch to
            Findings.
          </p>
        </section>
        <section className="band demo-findings" aria-labelledby="demo-findings-title">
          <h2 id="demo-findings-title">Seven findings came out of thirteen minutes</h2>
          <ol className="finding-list">
            {FINDINGS.map((f) => (
              <li key={f.id}>
                <span className={`chip ${f.impact === "Blocked" ? "chip-dot" : "chip-mute"}`}>
                  {f.impact}
                </span>
                <span className="finding-id">{f.id}</span>
                <p>{f.text}</p>
              </li>
            ))}
          </ol>
          <p className="demo-note">
            Two of the seven are blocked tasks; the rest are friction and one recovery. The analysis
            says so itself when a capture does not prove a claim, and the Observer&apos;s Findings
            view links every observation to its evidence.
          </p>
        </section>
        <section className="band demo-how" aria-labelledby="demo-how-title">
          <h2 id="demo-how-title">This is one study file and one command</h2>
          <p>
            A study declares the app, eight participants with a persona each, one marked host, and
            the missions. The orchestrator reads the join code off the host&apos;s screen and hands
            it to the followers. Each participant is a real desktop; the model key stays on this
            machine. The run wrote itself under <code>.humanish/runs/</code>, and{" "}
            <code>humanish analyze</code> ran once afterwards at an $11.38 admission estimate that
            came to $2.29.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="/docs">
              Run one on your app
            </a>
            <a
              className="cta-link"
              href="/runs/lobby-0927/observer/index.html"
              target="_blank"
              rel="noopener"
            >
              Open the raw Observer artifact →
            </a>
          </div>
        </section>
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
