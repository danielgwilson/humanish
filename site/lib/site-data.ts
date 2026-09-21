/**
 * Facts the homepage renders. Every number here is read from a kept run bundle or a
 * committed receipt; the link beside each one is where a reader checks it. Update the
 * receipt first, then this file.
 */
export const GITHUB = "https://github.com/danielgwilson/humanish";
export const RECEIPTS = `${GITHUB}/blob/main/docs/goals/computer-use-actor/receipts`;
export const BENCH = `${GITHUB}/blob/main/bench`;
/** Mirrors the root package.json version at the time of this build. */
export const VERSION = "0.91.1";

export interface EmbeddedRun {
  /** Directory under /public/runs/. */
  slug: string;
  runId: string;
  title: string;
  participant: string;
  device: string;
  brain: string;
  shots: number;
  /** Estimated cost in the bundle's own words, with its rates date. */
  costLine: string;
  /** A verbatim line from the participant's closing report. */
  quote: string;
  posterAlt: string;
  /** Observer stream id for the deep link. Single-participant runs use stream-001. */
  streamId: string;
  /** Poster aspect ratio as "w / h". */
  aspect: string;
}

/** The starter lab, run today from a fresh install of the published package. */
export const TRY_LIVE: EmbeddedRun = {
  slug: "try-live",
  runId: "cua-2026-09-16T16-20-26-762Z-c44a6d1d",
  title: "Your first study: one newcomer adds two tables to drawDB",
  participant: "First-time trial user",
  device: "hosted desktop · 1440×950 · Chrome",
  brain: "Codex, signed in on the operator's machine, acting as the participant",
  shots: 8,
  costLine: "est. $0.02 of desktop time; model tokens are unpriced on the local-agent route (rates as of 2026-09-05)",
  quote:
    "I hesitated at the required database choice and chose Generic. Finding the Name field required expanding a table. The tables appeared to overlap on the canvas, which was confusing despite both appearing in the sidebar.",
  posterAlt:
    "Observer keyframe: drawDB in Chrome on the hosted desktop, two tables named customers and orders created by the participant",
  streamId: "stream-001",
  aspect: "1440 / 950"
};

/** humanish studying its own landing page, 2026-09-16. Participants read the previous page. */
export const SELF_STUDY: EmbeddedRun[] = [
  {
    slug: "site-newcomer",
    runId: "cua-2026-09-16T16-14-55-258Z-1b895471",
    title: "A newcomer sent a link decides whether to try it",
    participant: "First-time trial user",
    device: "hosted desktop · 1440×950",
    brain: "gpt-5.6-sol computer use",
    shots: 22,
    costLine: "est. $0.40 (rates as of 2026-09-03)",
    quote:
      "The large scroll-driven replay made the homepage feel unnecessarily long, while its heavily obscured screenshots were difficult to evaluate. Some gray text in the dark section had weak contrast.",
    posterAlt: "Observer keyframe: the previous humanish.dev homepage in Chrome on the hosted desktop",
    streamId: "stream-001",
    aspect: "1440 / 950"
  },
  {
    slug: "site-skeptic",
    runId: "cua-2026-09-16T16-15-40-273Z-85fad4cf",
    title: "A skeptical engineer audits the claims, keyboard first",
    participant: "Skeptical power user",
    device: "hosted desktop · 1440×950",
    brain: "gpt-5.6-sol computer use",
    shots: 32,
    costLine: "est. $0.76 (rates as of 2026-09-03)",
    quote:
      "The site is excellent at stating limitations and presenting denominators, but its headline “evidence” remains mostly curated summaries. The flagship Excalidraw run is local_only; the TodoMVC receipt omits run IDs, provider identifiers, and raw bundles.",
    posterAlt: "Observer keyframe: the previous humanish.dev homepage, TodoMVC study section, on the hosted desktop",
    streamId: "stream-001",
    aspect: "1440 / 950"
  },
  {
    slug: "site-phone",
    runId: "cua-2026-09-16T16-16-25-270Z-4e1a53ee",
    title: "A newcomer opens the page on a phone",
    participant: "First-time trial user",
    device: "emulated phone · 414×896 · touch · DPR 3",
    brain: "gpt-5.6-sol computer use",
    shots: 14,
    costLine: "est. $0.15 or more; one usage receipt was not reported (rates as of 2026-09-03)",
    quote:
      "The Observer screenshots in the Excalidraw study are scaled down so far that their interface details are effectively unreadable. In the commands section, --yes wrapped between -- and yes, making the option momentarily confusing.",
    posterAlt: "Observer keyframe: the previous humanish.dev homepage at phone width on the emulated device",
    streamId: "stream-001",
    aspect: "500 / 896"
  }
];

/** What the three participants reported, and the change on this page that answers it. */
export const SELF_STUDY_CHANGES: Array<{ reported: string; who: string; changed: string }> = [
  {
    reported: "the scroll-driven replay made the page long and its screenshots were obscured",
    who: "all three",
    changed: "the seven-step replay is gone; a real Observer recording is embedded instead, with its screenshots at full size"
  },
  {
    reported: "“real human(ish) users” read as human testing",
    who: "newcomer, phone",
    changed: "the first line above the headline says synthetic, and the page names the persona and model behind every run"
  },
  {
    reported: "pricing had to be pieced together from three places",
    who: "newcomer",
    changed: "a cost table with the participant, desktop and analysis lines, from kept bundles"
  },
  {
    reported: "the headline evidence was curated summaries; run ids and bundles were not inspectable",
    who: "skeptic",
    changed: "every recording on this page is the bundle itself, opened in Observer, with its run id and its review file beside it"
  },
  {
    reported: "gray text in the dark band and footer had weak contrast; mono labels were very small",
    who: "newcomer, phone",
    changed: "secondary text in the dark band and footer is brighter, and the smallest labels are 11 px or larger"
  },
  {
    reported: "Page Up did not move the page after End inside the replay",
    who: "skeptic",
    changed: "the pinned track that stopped Page Up from moving the page is removed"
  }
];
