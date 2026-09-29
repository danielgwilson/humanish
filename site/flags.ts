import type { ReadonlyRequestCookies } from "flags";
import { dedupe, flag } from "flags/next";
import { postHogAdapter } from "@flags-sdk/posthog";

/**
 * Homepage variant. The value is decided server-side by PostHog for a stable per-visitor
 * id (cookie `hm_vid`, set in proxy.ts) and precomputed into the URL, so every variant is a
 * static page and the visitor sees no layout shift. PostHog experiments on the same flag read
 * the exposure event the client sends on load. The 2026-09-21 experiment (current vs option-1)
 * ended 2026-09-27 with option-1 released to everyone; the flag stays for the next round.
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
 * gets the default variant, which is the released design.
 */
const decideWithPostHog = Boolean(process.env.POSTHOG_PROJECT_API_KEY);

export const homepageVariant = flag<string, Entities>({
  key: "homepage-variant",
  description:
    "Which homepage a visitor sees: the released design (option-1, since 2026-09-27) or the 2026-09-14 design (current, kept at /legacy).",
  defaultValue: "option-1",
  options: [
    { value: "option-1", label: "Released design (2026-09-27)" },
    { value: "current", label: "Previous design (2026-09-14)" },
  ],
  ...(decideWithPostHog ? { adapter: postHogAdapter } : { decide: () => "option-1" }),
  identify,
});

export const homepageFlags = [homepageVariant] as const;
