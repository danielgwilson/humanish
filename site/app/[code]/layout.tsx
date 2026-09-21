import { generatePermutations } from "flags/next";
import { homepageFlags } from "@/flags";

// Precompute signs its codes with FLAGS_SECRET. Vercel has one per environment; a build with
// no environment (CI) gets a throwaway value so the build itself can be verified. Nothing built
// without the real secret is deployed, and the proxy never runs in that case.
if (!process.env.FLAGS_SECRET) process.env.FLAGS_SECRET = "ci-build-only-secret-not-used-at-runtime-0000";

/** One static page per flag permutation, built ahead of time (ISR fills any new one). */
export async function generateStaticParams() {
  const codes = await generatePermutations(homepageFlags);
  return codes.map((code) => ({ code }));
}

export default function CodeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
