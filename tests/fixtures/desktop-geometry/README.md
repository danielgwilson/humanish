# Physical browser geometry fixture

Captured from a disposable hosted Linux desktop on 2026-09-21. Window title and X window/colormap identifiers were replaced with synthetic values; measurements are unchanged. No provider identifiers or target application data are included.

The screen was 1440×950. `xwininfo -id <owned-window> -stats` reported absolute client origin (0, 51), relative origin (0, 24), and size 1440×899. The same window was visibly contained, with ordinary browser controls. The installed xdotool 3.20160805.1 reported origin (0, 75), double-counting the 24px decoration and falsely indicating bottom overflow.

Upstream comparison: [old coordinate translation](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/xdo.c) and [X.Org xwininfo reference](https://www.x.org/archive/X11R7.7/doc/man/man1/xwininfo.1.xhtml). Raw paired screenshots/measurements remain in the maintainer's private retained proof.
