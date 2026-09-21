import type { ReadonlyRequestCookies } from "flags";
import { dedupe, flag } from "flags/next";
import { postHogAdapter } from "@flags-sdk/posthog";

/**
 * Homepage experiment. The variant is decided server-side by PostHog for a stable
 * per-visitor id (cookie `hm_vid`, set in proxy.ts) and precomputed into the URL, so
 * every variant is a static page and the visitor sees no layout shift. PostHog's
 * experiment on the same flag reads the exposure event the client sends on load.
 */
export const VISITOR_COOKIE = "hm_vid";

export interface Entities {
  distinctId: string;
}

export const identify = dedupe(({ cookies }: { cookies: ReadonlyRequestCookies }): Entities => {
  return { distinctId: cookies.get(VISITOR_COOKIE)?.value ?? "anonymous" };
});

export const HOMEPAGE_VARIANTS = ["current", "option-1"] as const;
export type HomepageVariant = (typeof HOMEPAGE_VARIANTS)[number];

/**
 * The PostHog adapter reads POSTHOG_PROJECT_API_KEY when it is constructed and throws without
 * it, which would fail any build that has no environment (CI). Without the key every visitor
 * gets the default variant, which is the production design.
 */
const decideWithPostHog = Boolean(process.env.POSTHOG_PROJECT_API_KEY);

export const homepageVariant = flag<string, Entities>({
  key: "homepage-variant",
  description: "Which homepage a visitor sees: the shipped design (current) or the 2026-09-20 refinement (option-1).",
  defaultValue: "current",
  options: [
    { value: "current", label: "Production design" },
    { value: "option-1", label: "Option 1, refined current" }
  ],
  ...(decideWithPostHog ? { adapter: postHogAdapter } : { decide: () => "current" }),
  identify
});

export const homepageFlags = [homepageVariant] as const;
