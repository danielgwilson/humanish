/**
 * `xwininfo -id <win> -stats` output for a viewable window filling a fake desktop's screen. The
 * code reads physical browser bounds from it (src/substrates/e2b/desktop-geometry.ts); a real
 * capture is tests/fixtures/desktop-geometry/xwininfo-maximized.txt.
 */
export function fullScreenXwininfo(width: number, height: number): string {
  return [
    `  Absolute upper-left X:  0`,
    `  Absolute upper-left Y:  0`,
    `  Width: ${width}`,
    `  Height: ${height}`,
    `  Map State: IsViewable`,
    "",
  ].join("\n");
}
