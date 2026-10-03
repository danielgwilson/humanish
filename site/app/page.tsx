import Home from "@/components/home";
import PostHogClient from "@/components/analytics/posthog-client";

export default function Page() {
  return (
    <>
      <Home />
      <PostHogClient />
    </>
  );
}
