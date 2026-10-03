"use client";

import { useEffect } from "react";
import type { PostHog } from "posthog-js";

declare global {
  interface Window {
    __hmPosthog?: PostHog | true;
  }
}

// A long timeout: the 4 s one forced posthog-js to initialise while a throttled phone was still
// busy hydrating (a 470 ms task in the trace), which is exactly the window it should stay out of.
// On an idle main thread the callback still runs within a second of load.
function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(task, { timeout: 15000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, 3000);
  return () => window.clearTimeout(id);
}

/**
 * Loads posthog-js after the page is idle (never on the critical path) and initialises it once.
 * Session recording and surveys stay off: a landing page has no business recording its
 * visitors, and their scripts were a third of the page's unused JavaScript.
 * Without NEXT_PUBLIC_POSTHOG_KEY this renders nothing and captures nothing.
 */
export default function PostHogClient() {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || window.__hmPosthog) return;
    window.__hmPosthog = true;
    let cancelled = false;
    const cancel = whenIdle(() => {
      void import("posthog-js").then(({ default: posthog }) => {
        if (cancelled) return;
        posthog.init(key, {
          api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
          person_profiles: "identified_only",
          capture_pageview: true,
          capture_pageleave: true,
          autocapture: true,
          respect_dnt: true,
          disable_session_recording: true,
          disable_surveys: true,
          // The site reads no feature flags, so it does not ask PostHog to evaluate them.
          advanced_disable_feature_flags_on_first_load: true,
        });
        window.__hmPosthog = posthog;
      });
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, []);
  return null;
}

/** Fire-and-forget event for CTAs and copy buttons; a no-op until PostHog has loaded. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const client = window.__hmPosthog;
  if (!client || client === true) return;
  client.capture(event, properties);
}
