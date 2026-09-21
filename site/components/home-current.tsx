import Commands from "@/components/commands";
import Footer from "@/components/footer";
import Hero from "@/components/hero";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";
import Study from "@/components/study";
import Trust from "@/components/trust";

/** The homepage as it shipped on 2026-09-14. Variant `current`, and the flag's default. */
export default function HomeCurrent() {
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
