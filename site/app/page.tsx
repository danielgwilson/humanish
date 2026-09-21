import HomeCurrent from "@/components/home-current";

/** Fallback for `/` when the proxy did not run (it rewrites `/` to the precomputed variant). */
export default function Home() {
  return <HomeCurrent />;
}
