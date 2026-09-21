import type { Metadata } from "next";
import Commands from "@/components/commands";
import Footer from "@/components/footer";
import Hero from "@/components/hero";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";
import Study from "@/components/study";
import Trust from "@/components/trust";

export const metadata: Metadata = {
  title: "humanish — previous homepage (review)",
  robots: { index: false, follow: false }
};

/** The homepage as it shipped before the 2026-09-16 redesign, kept for side-by-side review. */
export default function Legacy() {
  return (
    <>
      <Nav links={[
        { label: "Study", href: "#study" },
        { label: "Commands", href: "#commands" },
        { label: "Trust", href: "#trust" },
        { label: "Docs", href: "/docs" }
      ]} />
      <main>
        <Hero />
        <Study />
        <Commands />
        <Trust />
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
