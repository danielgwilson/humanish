"use client";

import { useEffect } from "react";

/**
 * Scroll reveals: adds .in to .rev elements as they enter the viewport
 * (same thresholds as the POC). Without IO — or without JS at all — the
 * content is simply visible; reduced motion is handled in CSS. Hydrating
 * in time cancels the inline-script fallback timer that would otherwise
 * force everything visible via `rev-all` (see THEME_INIT in layout.tsx).
 */
export default function Reveals() {
  useEffect(() => {
    const w = window as Window & { __revFallback?: ReturnType<typeof setTimeout> };
    if (w.__revFallback !== undefined) {
      clearTimeout(w.__revFallback);
      delete w.__revFallback;
    }
    const els = Array.from(document.querySelectorAll(".rev"));
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const rio = new IntersectionObserver(
      (es) => {
        es.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            rio.unobserve(en.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -30px 0px" }
    );
    els.forEach((el) => rio.observe(el));
    return () => rio.disconnect();
  }, []);

  return null;
}
