import { ogImage, ogImageContentType, ogImageSize } from "../../lib/og-image";

export const alt = "humanish demo — eight synthetic participants, one lobby, seven findings";
export const size = ogImageSize;
export const contentType = ogImageContentType;

export default function OpengraphImage() {
  return ogImage("Eight synthetic participants, one app, seven findings");
}
