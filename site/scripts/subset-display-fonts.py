#!/usr/bin/env python3
"""Regenerate site/app/fonts/*.woff2: the glyphs the headline and wordmark use, cut from the same
Newsreader (both axes kept, weight limited to 300..400) and Geist (pinned at 600) that next/font
downloads for the full faces. Run after a site build so .next/static/media holds the sources:

    python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
    /tmp/fontenv/bin/python site/scripts/subset-display-fonts.py

Then update the sha256 pins in scripts/public-surface-scan.mjs. The "0-" prefix keeps these ahead of the
full faces in the preload order Next emits (file-name order). Change HEADLINE if the hero copy
changes; a glyph outside the subset falls back to the full face per character, so nothing breaks,
but the headline would then wait for the big file again."""
import glob, os, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
MEDIA = os.path.join(SITE, ".next", "static", "media")
OUT = os.path.join(SITE, "app", "fonts")
HEADLINE = "Instant feedback from real human(ish) users"

def find(family, style):
    for path in sorted(glob.glob(os.path.join(MEDIA, "*.woff2")), key=os.path.getsize, reverse=True):
        f = TTFont(path)
        if f["name"].getDebugName(1) == family and f["name"].getDebugName(2) == style and "fvar" in f:
            return path
    sys.exit(f"no {family} {style} in {MEDIA}; run a site build first")

def make(src, dst, chars, limits):
    f = instancer.instantiateVariableFont(TTFont(src), limits)
    opts = subset.Options(); opts.flavor = "woff2"; opts.layout_features = ["*"]; opts.name_IDs = ["*"]; opts.notdef_outline = True
    s = subset.Subsetter(opts); s.populate(unicodes=[ord(c) for c in chars]); s.subset(f)
    f.flavor = "woff2"; f.save(dst)
    print(f"{os.path.relpath(dst, SITE)}: {os.path.getsize(dst)} bytes, {''.join(sorted(chars))!r}")

os.makedirs(OUT, exist_ok=True)
roman = sorted(set(HEADLINE.replace("human", "").replace("ish", "")) | set(" ()"))
make(find("Newsreader 16pt", "Regular"), os.path.join(OUT, "0-display-newsreader.woff2"), roman, {"wght": (300, 400)})
make(find("Newsreader 16pt", "Italic"), os.path.join(OUT, "0-display-newsreader-italic.woff2"), sorted(set("ish")), {"wght": (300, 400)})
make(find("Geist", "Regular"), os.path.join(OUT, "0-display-geist-600.woff2"), sorted(set("human")), {"wght": 600})
