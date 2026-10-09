import { ogImage, ogImageContentType, ogImageSize } from "../lib/og-image";

export const alt = "humanish — instant feedback from real human(ish) users";
export const size = ogImageSize;
export const contentType = ogImageContentType;

export default function OpengraphImage() {
  return ogImage("User testing for the users you can’t recruit");
}
