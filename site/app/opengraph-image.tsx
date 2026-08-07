import { ImageResponse } from "next/og";

export const alt = "humanish — instant feedback from real human(ish) users";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const OG_LINE = "User testing for the users you can’t recruit";

/** Fetch a text-subset TTF from Google Fonts at build time (nothing committed). */
async function loadGoogleFont(css2Family: string, text: string): Promise<ArrayBuffer> {
  const url = `https://fonts.googleapis.com/css2?family=${css2Family}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(url)).text();
  const resource = css.match(/src: url\((.+)\) format\('(opentype|truetype)'\)/);
  if (resource?.[1]) {
    const res = await fetch(resource[1]);
    if (res.ok) return res.arrayBuffer();
  }
  throw new Error(`failed to load font: ${css2Family}`);
}

export default async function OpengraphImage() {
  const [geist, newsParens, newsIsh, newsLead] = await Promise.all([
    loadGoogleFont("Geist:wght@600", "human"),
    loadGoogleFont("Newsreader:wght@300", "()"),
    loadGoogleFont("Newsreader:ital,wght@1,400", "ish"),
    loadGoogleFont("Newsreader:ital,wght@1,300", OG_LINE)
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#fbfaf7",
          padding: "0 96px"
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span
            style={{
              fontFamily: "Geist",
              fontWeight: 600,
              fontSize: 148,
              color: "#1c1a16",
              letterSpacing: "-0.01em"
            }}
          >
            human
          </span>
          <span style={{ fontFamily: "Newsreader", fontWeight: 300, fontSize: 163, color: "#2b3fd6" }}>(</span>
          <span
            style={{
              fontFamily: "Newsreader Italic",
              fontStyle: "italic",
              fontWeight: 400,
              fontSize: 163,
              color: "#1c1a16"
            }}
          >
            ish
          </span>
          <span style={{ fontFamily: "Newsreader", fontWeight: 300, fontSize: 163, color: "#2b3fd6" }}>)</span>
        </div>
        <div
          style={{
            marginTop: 40,
            fontFamily: "Newsreader Italic",
            fontStyle: "italic",
            fontWeight: 300,
            fontSize: 46,
            color: "#6e6a61"
          }}
        >
          {OG_LINE}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: geist, weight: 600, style: "normal" },
        { name: "Newsreader", data: newsParens, weight: 300, style: "normal" },
        { name: "Newsreader Italic", data: newsIsh, weight: 400, style: "italic" },
        { name: "Newsreader Italic", data: newsLead, weight: 300, style: "italic" }
      ]
    }
  );
}
