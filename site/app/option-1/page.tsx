import type { Metadata } from "next";
import HomeOption1 from "@/components/home-option-1";

export const metadata: Metadata = { title: "humanish — option 1 (review)", robots: { index: false, follow: false } };

export default function Option1() {
  return <HomeOption1 />;
}
