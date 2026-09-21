"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

declare global {
  interface Window { __hmPosthog?: boolean }
}

/**
 * Initialises posthog-js once, bootstrapped with the visitor id the proxy assigned (read
 * from the `hm_vid` cookie) and the flag values the page was rendered with, so the client never re-evaluates flags and
 * the exposure it reports (`$feature_flag_called`) names the variant the visitor saw.
 * Without NEXT_PUBLIC_POSTHOG_KEY this renders nothing and captures nothing.
 */
const VISITOR_COOKIE = "hm_vid";

function readVisitorId(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${VISITOR_COOKIE}=([^;]+)`));
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export default function PostHogClient({ flags }: { flags: Record<string, string> }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    const distinctId = readVisitorId();
    if (!window.__hmPosthog) {
      window.__hmPosthog = true;
      posthog.init(key, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: true,
        capture_pageleave: true,
        autocapture: true,
        respect_dnt: true,
        bootstrap: { ...(distinctId ? { distinctID: distinctId } : {}), featureFlags: flags }
      });
    }
    // Reading the flag is what emits the exposure event the experiment counts.
    for (const flag of Object.keys(flags)) posthog.getFeatureFlag(flag);
  }, [flags]);
  return null;
}

/** Fire-and-forget event for CTAs and copy buttons; a no-op when PostHog is not configured. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === "undefined" || !window.__hmPosthog) return;
  posthog.capture(event, properties);
}
