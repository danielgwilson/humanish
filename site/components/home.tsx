import Commands from "@/components/commands";
import Footer from "@/components/footer";
import Hero from "@/components/hero";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";
import StudyV3 from "@/components/study-v3";
import Trust from "@/components/trust";
import Faq from "@/components/faq";
import Closer from "@/components/closer";

/** The homepage: the 2026-09-20 refinement, released to all visitors on 2026-09-27 (flag value `option-1`). */
export default function Home() {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
        <StudyV3 />
        <Commands />
        <Trust />
        <Faq />
        <Closer />
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
