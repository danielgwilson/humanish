import { useCallback, useEffect, useRef, useState } from "react";

/** The actions that take two Enters: each spends money, ends paid work, or writes files. */
type ArmedAction = "live-start" | "run-again" | "stop" | "cancel-analysis" | "init";

/**
 * The shortest gap between arming and confirming. Key auto-repeat delivers around one event every
 * 30ms, so without a floor a held Enter arms and confirms inside a single keypress.
 */
const CONFIRM_FLOOR_MS = 400;

/**
 * How long an armed action waits for its confirming Enter. The longest prompt, a live start that
 * restates the analysis budget, is about seventy words; an Enter after this long arms again.
 */
const CONFIRM_WINDOW_MS = 30_000;

interface Armed {
  action: ArmedAction;
  place: string;
  at: number;
}

export interface Arming {
  /** The action armed at the current place, for the prompt that says so. */
  armed: ArmedAction | undefined;
  /**
   * An Enter on `action`. It confirms only the same action armed at the same place, at least the
   * floor and less than the window ago. Inside the floor it is key auto-repeat and changes nothing.
   * Otherwise it arms.
   */
  press(action: ArmedAction): "armed" | "held" | "confirmed";
  /** Cancel whatever is armed. True when something was. */
  disarm(): boolean;
}

/**
 * The one owner of every armed confirmation. `place` names the screen and the action under the
 * cursor; an arming ends when it changes, when the window passes, or on `disarm`, and a place that
 * changes back does not bring it back.
 */
export function useArming(place: string): Arming {
  // Decisions read the ref. Ink parses one stdin chunk into several keys and handles them before
  // React renders, so a "j k Enter" chunk has to see the disarm the "j" made.
  const ref = useRef<Armed | undefined>(undefined);
  const [armed, setArmed] = useState<Armed | undefined>(undefined);
  const set = useCallback((next: Armed | undefined) => {
    ref.current = next;
    setArmed(next);
  }, []);

  // The place can change with no key: a refresh swaps Stop for Run again, or another run opens.
  useEffect(() => {
    if (ref.current !== undefined && ref.current.place !== place) set(undefined);
  }, [place, set]);

  useEffect(() => {
    if (armed === undefined) return;
    const timer = setTimeout(() => {
      if (ref.current === armed) set(undefined);
    }, CONFIRM_WINDOW_MS);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [armed, set]);

  const press = useCallback(
    (action: ArmedAction): "armed" | "held" | "confirmed" => {
      const now = Date.now();
      const current = ref.current;
      if (
        current !== undefined &&
        current.action === action &&
        current.place === place &&
        now - current.at < CONFIRM_WINDOW_MS
      ) {
        if (now - current.at < CONFIRM_FLOOR_MS) return "held";
        set(undefined);
        return "confirmed";
      }
      set({ action, place, at: now });
      return "armed";
    },
    [place, set],
  );

  const disarm = useCallback((): boolean => {
    if (ref.current === undefined) return false;
    set(undefined);
    return true;
  }, [set]);

  return { armed: armed?.place === place ? armed.action : undefined, press, disarm };
}
