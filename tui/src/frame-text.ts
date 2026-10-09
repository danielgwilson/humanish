import { contentWidth, type FrameProps } from "./frame.js";
import type { ArmedAction } from "./arming.js";
import type { Screen } from "./navigation.js";
import { itemsForStudy, liveRunsOf, type ProjectData } from "./project.js";
import { runActions } from "./screens/run-screen.js";

/** Everything the header, breadcrumb and key legend depend on. */
export interface FrameTextView {
  screen: Screen;
  data: ProjectData | undefined;
  selected: number;
  /** The action waiting for its confirming Enter, as `useArming` reports it. */
  armed: ArmedAction | undefined;
  initialized: boolean;
  /** A screen drawn over the navigation stack, which writes its own breadcrumb and legend. */
  overlay: "keys" | "connections" | "help" | undefined;
  /** Whether the keys and accounts screen exists in this build, so `c` is worth listing. */
  connections: boolean;
  cwd: string;
  /** Terminal width. The legend is fitted to the frame's capped content width. */
  columns: number;
}

/** The text the frame draws around the current screen. */
export function frameText(
  view: FrameTextView,
): Pick<FrameProps, "context" | "breadcrumb" | "hints"> {
  return {
    context: contextLine(view),
    breadcrumb:
      view.overlay === "keys"
        ? "‹ keys and accounts"
        : view.overlay === "connections"
          ? "‹ connections"
          : breadcrumbOf(view),
    hints:
      view.overlay === "keys" || view.overlay === "connections"
        ? "↑↓ move  ⏎ select  esc back  q quit"
        : view.overlay === "help"
          ? "any key returns   q quit"
          : keyHints(view) + (view.connections ? "   c keys and accounts" : ""),
  };
}

/**
 * The right of the header: the project, and whether anyone is working in it. The two things a
 * stakeholder wants without reading anything else.
 */
function contextLine({ screen, data, cwd }: FrameTextView): string | undefined {
  const project = cwd.split("/").filter(Boolean).pop();
  // On a run card the context carries which run, because the card itself leads with the verdict:
  // the id still has to be somewhere, and this is where the mock puts it.
  if (screen.name === "run" && data !== undefined) {
    const run = data.runsById.get(screen.runId);
    const short = screen.runId.split("-").pop() ?? screen.runId;
    return [run?.study?.id, short].filter(Boolean).join(" · ");
  }
  if (data === undefined) return project;
  const live = liveRunsOf(data).length;
  if (live === 0) return project;
  return `${project} · ${live} participant${live === 1 ? "" : "s"} working`;
}

/** Where you are, as a path back. */
function breadcrumbOf({ screen, data }: FrameTextView): string | undefined {
  if (screen.name === "studies") return undefined;
  if (screen.name === "all-runs") return "‹ studies / all runs";
  if (screen.name === "study") {
    const row = data?.rows.find((candidate) => candidate.key === screen.studyKey);
    return `‹ studies / ${row?.name ?? screen.studyKey}`;
  }
  const study = screen.studyId;
  return study === undefined ? "‹ studies / run" : `‹ studies / ${study} / run`;
}

/**
 * Only the keys that do something here, and named for what they do to the current row. Enter starts
 * a run on one row and opens a run on the next, so a fixed legend would be wrong half the time:
 * and a legend that lists inert keys teaches the wrong model of the surface.
 */
function keyHints(view: FrameTextView): string {
  // A legend that wraps leaves a lone "quit" on its own line. The arrows read as movement without
  // the word, so a narrow terminal drops it first.
  const full = legendFor(view, "↑↓ move");
  return [...full].length <= contentWidth(view.columns) ? full : legendFor(view, "↑↓");
}

function legendFor(
  { screen, data, selected, armed, initialized }: FrameTextView,
  move: string,
): string {
  // While an action is armed, Enter confirms it and any other key cancels it (app.tsx), whatever
  // the row would otherwise do. Cancel analysis says what cancelling it keeps, as its prompt does,
  // because "esc cancel" next to "cancel analysis?" reads as the key that cancels the analysis.
  if (armed !== undefined)
    return `⏎ confirm  esc ${armed === "cancel-analysis" ? "keep analyzing" : "cancel"}`;
  switch (screen.name) {
    case "studies":
      // Nothing to move through or open on an empty screen, and a legend that lists inert keys
      // teaches the wrong model of the surface.
      if ((data?.rows.length ?? 0) > 0) return `${move}  ⏎ open  ? shortcuts  q quit`;
      // An empty screen with one action still has that action; a legend that omits it makes the
      // row look decorative.
      return !initialized ? "⏎ set up humanish here  ? shortcuts  q quit" : "? shortcuts  q quit";
    case "study": {
      const item =
        data === undefined ? undefined : itemsForStudy(data, screen.studyKey).items[selected];
      const enter = item?.kind === "start" ? "⏎ start" : "⏎ open";
      return `${move}  ${enter}  esc back  ? shortcuts  q quit`;
    }
    case "all-runs":
      return `${move}  ⏎ open  esc back  ? shortcuts  q quit`;
    default: {
      // Only when the card actually has actions: an empty legend beats one promising a key that
      // does nothing on a run still in flight.
      const run =
        data === undefined
          ? undefined
          : data.runsById.get(screen.name === "run" ? screen.runId : "");
      const hasActions = run !== undefined && runActions(run, undefined).length > 0;
      return hasActions
        ? `${move}  ⏎ select  esc back  ? shortcuts  q quit`
        : "esc back  ? shortcuts  q quit";
    }
  }
}
