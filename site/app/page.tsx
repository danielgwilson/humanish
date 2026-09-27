import Home from "@/components/home";

/** Fallback for `/` when the proxy did not run (it rewrites `/` to the precomputed variant). */
export default function Page() {
  return <Home />;
}
