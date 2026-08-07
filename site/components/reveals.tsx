"use client";

import { useEffect } from "react";

/**
 * Scroll reveals: adds .in to .rev elements as they enter the viewport
 * (same thresholds as the POC). Without IO — or without JS at all — the
 * content is simply visible; reduced motion is handled in CSS.
 */
export default function Reveals() {
  useEffect(() => {
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
