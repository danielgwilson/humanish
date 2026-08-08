"use client";

import { useEffect } from "react";

/**
 * Scroll reveals: adds .in to .rev elements as they approach the viewport.
 * The observer root is grown 25% of the viewport height downward, so a band
 * starts its fade before it is on screen — the POC's -30px bottom inset
 * armed the reveal only after a band had already scrolled in, which read as
 * a blank still-loading section to anyone scrolling quickly. Growing the
 * root only moves the trigger earlier; the at-rest revealed state is
 * unchanged. Without IO — or without JS at all — the content is simply
 * visible; reduced motion is handled in CSS. Hydrating in time cancels the
 * inline-script fallback timer that would otherwise force everything
 * visible via `rev-all` (see THEME_INIT in layout.tsx).
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
      { threshold: 0.15, rootMargin: "0px 0px 25% 0px" }
    );
    els.forEach((el) => rio.observe(el));
    return () => rio.disconnect();
  }, []);

  return null;
}
