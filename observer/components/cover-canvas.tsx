"use client";

import { useEffect, useRef, useState } from "react";
import { registerCover, resolveCover } from "@/lib/humanish/covers";
import { prefersReducedMotion } from "@/lib/humanish/theme";

/**
 * CoverCanvas — one resolve-cover veil over a screenshot. Registers itself
 * with the shared cover engine on mount; reduced motion removes it (finished
 * state = the plain screenshot), exactly like the POC.
 *
 * `resolveAfter` (ms) self-resolves after mount — used by the hero tile
 * (1100ms). Panels inside PinnedReplay omit it; the replay triggers them.
 */
export default function CoverCanvas({
  n,
  resolveAfter
}: {
  n: string;
  resolveAfter?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (prefersReducedMotion()) {
      setRemoved(true);
      return;
    }
    const unregister = registerCover(c, n);
    if (resolveAfter !== undefined) resolveCover(c, resolveAfter);
    return unregister;
  }, [n, resolveAfter]);

  if (removed) return null;
  return <canvas className="cover" data-n={n} ref={ref}></canvas>;
}
