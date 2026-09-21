"use client";

import { useEffect, useRef, useState } from "react";

/** True while the element is at least partly on screen; false again when it leaves. */
export function useInView<T extends HTMLElement>(margin = "0px") {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) { setInView(true); return; }
    const io = new IntersectionObserver((es) => setInView(es[0]?.isIntersecting ?? false), { rootMargin: margin, threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return { ref, inView };
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
