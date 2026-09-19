import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Animate only a deliberate pin reorder, never capture updates or filtering.
 * Existing keyed cards (and their focused controls) stay mounted. */
export function usePinReorder(grid: RefObject<HTMLDivElement | null>, order: string, onPin?: (id: string) => void) {
  const pending = useRef<{ boxes: Map<string, DOMRect>; scroll: number } | null>(null);
  const animations = useRef<Animation[]>([]);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => { animations.current.forEach((animation) => animation.cancel()); };
    const changed = () => { if (preference.matches) cancel(); };
    preference.addEventListener?.("change", changed);
    return () => { preference.removeEventListener?.("change", changed); cancel(); };
  }, []);
  useLayoutEffect(() => {
    const previous = pending.current;
    pending.current = null;
    if (!previous || !grid.current) return;
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    const scroller = grid.current.closest(".content");
    if (scroller) scroller.scrollTop = previous.scroll;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const card of grid.current.querySelectorAll<HTMLElement>(".card[data-stream-id]")) {
      const before = previous.boxes.get(card.dataset.streamId!);
      if (!before || typeof card.animate !== "function") continue;
      const after = card.getBoundingClientRect();
      const x = before.left - after.left, y = before.top - after.top;
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
      animations.current.push(card.animate([
        { transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" },
      ], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" }));
    }
  }, [order, grid]);
  return onPin ? (id: string) => {
    const node = grid.current;
    if (node) pending.current = {
      boxes: new Map([...node.querySelectorAll<HTMLElement>(".card[data-stream-id]")].map((card) => [card.dataset.streamId!, card.getBoundingClientRect()])),
      scroll: node.closest(".content")?.scrollTop ?? 0,
    };
    onPin(id);
  } : undefined;
}
