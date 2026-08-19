// Where you are and how you got there (#455).
//
// The shape Daniel's sketch settles on: OBJECTS navigate, lifecycle renders in place. You move
// between things that exist — the set of labs, one lab, one run — and a run's state (queued,
// running, finished, interrupted) is something the run screen renders, never somewhere you go. An
// earlier design had a screen per state; it made the same run feel like four different objects and
// left no answer to "where am I".
//
// Kept as a pure reducer so the whole navigation model is testable without a terminal, and so
// "Esc always goes back one level, and back from the top means quit" is one readable rule rather
// than a condition spread across three components.

export type Screen =
  | { name: "labs" }
  | { name: "lab"; labKey: string }
  | { name: "run"; labId?: string; runId: string };

export interface NavState {
  /** Top of the stack is the current screen. Never empty — `labs` is the floor. */
  stack: Screen[];
  /** Selected row index per screen key, so going back restores where you were. */
  selection: Record<string, number>;
  /** Set when the operator asked to leave. */
  quit: boolean;
}

export type NavEvent =
  | { type: "enter"; screen: Screen }
  | { type: "back" }
  | { type: "move"; delta: number; total: number }
  | { type: "select"; index: number; total: number }
  | { type: "quit" };

/** A stable key per screen instance, so selection is remembered per lab and per run. */
export function screenKey(screen: Screen): string {
  switch (screen.name) {
    case "labs":
      return "labs";
    case "lab":
      return `lab:${screen.labKey}`;
    default:
      return `run:${screen.runId}`;
  }
}

export function initialNav(): NavState {
  return { stack: [{ name: "labs" }], selection: {}, quit: false };
}

export function currentScreen(state: NavState): Screen {
  return state.stack[state.stack.length - 1] ?? { name: "labs" };
}

export function selectedIndex(state: NavState): number {
  return state.selection[screenKey(currentScreen(state))] ?? 0;
}

export function navigate(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case "enter":
      return { ...state, stack: [...state.stack, event.screen] };
    case "back":
      // Back from the top level is a request to leave. Making Esc quit there — rather than doing
      // nothing — means one key always means "out of here", which is what a person reaches for
      // when a surface has taken their screen.
      return state.stack.length <= 1
        ? { ...state, quit: true }
        : { ...state, stack: state.stack.slice(0, -1) };
    case "move": {
      if (event.total <= 0) return state;
      const key = screenKey(currentScreen(state));
      const from = state.selection[key] ?? 0;
      // Clamp rather than wrap. Wrapping means holding Down past the end silently teleports to the
      // top, and in a list of runs that is how someone opens the wrong run.
      const next = Math.min(Math.max(0, from + event.delta), event.total - 1);
      return next === from ? state : { ...state, selection: { ...state.selection, [key]: next } };
    }
    case "select": {
      if (event.total <= 0) return state;
      const key = screenKey(currentScreen(state));
      const next = Math.min(Math.max(0, event.index), event.total - 1);
      return { ...state, selection: { ...state.selection, [key]: next } };
    }
    default:
      return { ...state, quit: true };
  }
}
