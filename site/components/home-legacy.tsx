import Commands from "@/components/commands";
import Footer from "@/components/footer";
import Hero from "@/components/hero";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";
import Study from "@/components/study";
import Trust from "@/components/trust";

/** The homepage as it shipped on 2026-09-14 (flag value `current`). Served at /legacy for reference. */
export default function HomeLegacy() {
  return (
    <>
      <Nav
        links={[
          { label: "Study", href: "#study" },
          { label: "Commands", href: "#commands" },
          { label: "Trust", href: "#trust" },
          { label: "Docs", href: "/docs" },
        ]}
      />
      <main id="main">
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
