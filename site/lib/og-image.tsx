import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const ogImageSize = { width: 1200, height: 630 };
export const ogImageContentType = "image/png";

/**
 * Text subsets of Geist and Newsreader holding only the glyphs the images draw, committed in
 * og-fonts/ with their licenses so prerendering needs no network. Next runs the routes with the
 * site as the working directory. A line character missing from newsreader-italic-300-lines.ttf
 * makes satori fetch a fallback face from Google during the build, so rerun
 * scripts/fetch-og-fonts.mjs after changing a line.
 */
const [geist, newsreaderParens, newsreaderIsh, newsreaderLines] = await Promise.all([
  readFile(join(process.cwd(), "lib/og-fonts/geist-600-human.ttf")),
  readFile(join(process.cwd(), "lib/og-fonts/newsreader-300-parens.ttf")),
  readFile(join(process.cwd(), "lib/og-fonts/newsreader-italic-400-ish.ttf")),
  readFile(join(process.cwd(), "lib/og-fonts/newsreader-italic-300-lines.ttf")),
]);

/** The human(ish) wordmark over one line of copy, at `ogImageSize`. */
export function ogImage(line: string): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: "#fbfaf7",
        padding: "0 96px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <span
          style={{
            fontFamily: "Geist",
            fontWeight: 600,
            fontSize: 148,
            color: "#1c1a16",
            letterSpacing: "-0.01em",
          }}
        >
          human
        </span>
        <span
          style={{ fontFamily: "Newsreader", fontWeight: 300, fontSize: 163, color: "#2b3fd6" }}
        >
          (
        </span>
        <span
          style={{
            fontFamily: "Newsreader Italic",
            fontStyle: "italic",
            fontWeight: 400,
            fontSize: 163,
            color: "#1c1a16",
          }}
        >
          ish
        </span>
        <span
          style={{ fontFamily: "Newsreader", fontWeight: 300, fontSize: 163, color: "#2b3fd6" }}
        >
          )
        </span>
      </div>
      <div
        style={{
          marginTop: 40,
          fontFamily: "Newsreader Italic",
          fontStyle: "italic",
          fontWeight: 300,
          fontSize: 46,
          color: "#6e6a61",
        }}
      >
        {line}
      </div>
    </div>,
    {
      ...ogImageSize,
      fonts: [
        { name: "Geist", data: geist, weight: 600, style: "normal" },
        { name: "Newsreader", data: newsreaderParens, weight: 300, style: "normal" },
        { name: "Newsreader Italic", data: newsreaderIsh, weight: 400, style: "italic" },
        { name: "Newsreader Italic", data: newsreaderLines, weight: 300, style: "italic" },
      ],
    },
  );
}
