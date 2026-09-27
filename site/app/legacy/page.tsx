import type { Metadata } from "next";
import HomeLegacy from "@/components/home-legacy";

export const metadata: Metadata = {
  title: "humanish — previous homepage (review)",
  robots: { index: false, follow: false }
};

/** The homepage as it shipped before the 2026-09-27 release, kept for reference. */
export default function Legacy() {
  return <HomeLegacy />;
}
