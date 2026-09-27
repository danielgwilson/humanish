import { notFound } from "next/navigation";
import Home from "@/components/home";
import HomeLegacy from "@/components/home-legacy";
import PostHogClient from "@/components/analytics/posthog-client";
import { homepageFlags, homepageVariant } from "@/flags";

type Params = Promise<{ code: string }>;

/**
 * The homepage, precomputed per variant. proxy.ts rewrites `/` here with the code for the
 * visitor's assignment; the page reads the variant from the code (no re-evaluation) and
 * renders that composition, and stays static (no request-time reads). The client reads the
 * visitor cookie itself and reports the exposure to PostHog under that id, which is what the
 * experiment counts.
 *
 * Only the proxy mints codes. Any other single-segment path (/pricing, /option-1) lands here
 * too, and the decoder throws on it; that is a 404, not a 500.
 */
export default async function Page({ params }: { params: Params }) {
  const { code } = await params;
  let variant: string;
  try {
    variant = await homepageVariant(code, homepageFlags);
  } catch {
    notFound();
  }
  return (
    <>
      {variant === "current" ? <HomeLegacy /> : <Home />}
      <PostHogClient flags={{ "homepage-variant": variant }} />
    </>
  );
}
