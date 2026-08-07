import Commands from "@/components/commands";
import Footer from "@/components/footer";
import Hero from "@/components/hero";
import Nav from "@/components/nav";
import Reveals from "@/components/reveals";
import Study from "@/components/study";
import Trust from "@/components/trust";

export default function Home() {
  return (
    <>
      <Nav />
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
