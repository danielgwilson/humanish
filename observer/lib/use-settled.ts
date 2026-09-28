import { useEffect, useState } from "react";

/**
 * True only once `value` has stayed true for `delayMs`. A capture that decodes in a
 * few hundred milliseconds never shows a loading affordance; during grid playback
 * every frame change was flashing the bar and swapping the caption, which read as
 * flicker. Falls back to false the moment `value` does.
 */
export function useSettled(value: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!value) { setSettled(false); return; }
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return value && settled;
}
