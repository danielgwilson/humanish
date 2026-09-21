import Commands from "@/components/commands";
import Footer from "@/components/footer";
import Hero from "@/components/hero";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";
import StudyV3 from "@/components/study-v3";
import Trust from "@/components/trust";

/** Option 1 of the 2026-09-20 round: the shipped design, refreshed. Variant `option-1`. */
export default function HomeOption1() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <StudyV3 />
        <Commands />
        <Trust />
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
