import assert from "node:assert/strict";
import { PNG } from "pngjs";

/** Measure the native range thumb's actual painted pixels against the visible
 * timeline. CSS values alone cannot catch a browser's native-control geometry. */
export async function scrubberPixels(page, label = "Seek recording time") {
  const control = page.getByRole("slider", { name: label, exact: true });
  await control.scrollIntoViewIfNeeded();
  const wrapper = control.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' scrubwrap ')][1]");
  const geometry = await wrapper.evaluate((element) => {
    const range = element.querySelector("input"), track = element.querySelector(".scrub-track");
    const rect = element.getBoundingClientRect(), r = range.getBoundingClientRect(), t = track.getBoundingClientRect();
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(element.querySelector(".scrub-played")).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const color = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    const min = Number(range.min), max = Number(range.max), value = Number(range.value);
    const fraction = max > min ? (value - min) / (max - min) : 0;
    return { wrapper: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      track: { x: t.x, y: t.y, width: t.width, height: t.height },
      range: { x: r.x, y: r.y, width: r.width, height: r.height },
      expectedX: t.x + fraction * t.width, fraction, color,
      thumbSize: parseFloat(getComputedStyle(element).getPropertyValue("--scrub-thumb-size")) };
  });
  const png = PNG.sync.read(await wrapper.screenshot({ animations: "disabled" }));
  // Playwright clips element screenshots to integer CSS pixel boundaries.
  const clipX = Math.floor(geometry.wrapper.x), clipY = Math.floor(geometry.wrapper.y);
  const sx = png.width / (Math.ceil(geometry.wrapper.x + geometry.wrapper.width) - clipX);
  const sy = png.height / (Math.ceil(geometry.wrapper.y + geometry.wrapper.height) - clipY);
  const expectedX = (geometry.expectedX - clipX) * sx;
  const radius = geometry.thumbSize * sx / 2;
  const matches = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return false;
    const offset = (y * png.width + x) * 4;
    return geometry.color.every((v, n) => Math.abs(png.data[offset + n] - v) <= 3);
  };
  const runs = []; let run;
  for (let y = 0; y < png.height; y += 1) {
    let pixels = 0;
    for (let x = Math.max(0, Math.floor(expectedX - 2 * sx)); x <= Math.min(png.width - 1, Math.ceil(expectedX + 2 * sx)); x += 1) if (matches(x, y)) pixels += 1;
    if (pixels >= Math.max(2, Math.round(2 * sx))) { if (!run) run = { top: y, bottom: y }; else run.bottom = y; }
    else if (run) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  const thumb = runs.sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0];
  assert(thumb && thumb.bottom - thumb.top >= geometry.thumbSize * sy * .5, "Native thumb pixels are not discernible");
  let left = Infinity, right = -Infinity;
  // Rows away from the thin overlaid timeline isolate the native thumb horizontally.
  const trackY = (geometry.track.y + geometry.track.height / 2 - clipY) * sy;
  for (let y = thumb.top; y <= thumb.bottom; y += 1) {
    if (Math.abs(y + .5 - trackY) < 2 * sy) continue;
    for (let x = Math.max(0, Math.floor(expectedX - radius - 2)); x < Math.min(png.width, Math.ceil(expectedX + radius + 2)); x += 1) {
      if (matches(x, y)) { left = Math.min(left, x); right = Math.max(right, x); }
    }
  }
  assert(Number.isFinite(left) && Number.isFinite(right), "Native thumb paint was indistinguishable from the track");
  const paintedX = clipX + (left + right + 1) / (2 * sx);
  const paintedY = clipY + (thumb.top + thumb.bottom + 1) / (2 * sy);
  return { ...geometry, raster: { width: png.width, height: png.height }, paintedX, paintedY,
    xError: Math.abs(paintedX - geometry.expectedX), yError: Math.abs(paintedY - (geometry.track.y + geometry.track.height / 2)) };
}

export function assertScrubberAligned(measurement) {
  assert(measurement.xError <= 1, `Native thumb and timeline disagree horizontally by ${measurement.xError.toFixed(2)}px`);
  assert(measurement.yError <= 1, `Native thumb and timeline disagree vertically by ${measurement.yError.toFixed(2)}px`);
  assert(measurement.range.y >= measurement.wrapper.y - 1 && measurement.range.y + measurement.range.height <= measurement.wrapper.y + measurement.wrapper.height + 1,
    "Playback hit area escapes the timeline wrapper");
}
