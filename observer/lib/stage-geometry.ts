import type { CSSProperties } from "react";

/** A width and height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Where a desktop-pixel point sits on the shown frame, as percentages of the frame's box, or null
 * for a point outside the desktop. Pins and the drawn pointer both place themselves with it. */
export function pinPosition(coord: { x: number; y: number }, viewport: Size): CSSProperties | null {
  if (
    !Number.isFinite(coord.x) ||
    !Number.isFinite(coord.y) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    coord.x < 0 ||
    coord.y < 0 ||
    coord.x > viewport.width ||
    coord.y > viewport.height
  )
    return null;
  return {
    left: `${(100 * coord.x) / viewport.width}%`,
    top: `${(100 * coord.y) / viewport.height}%`,
  };
}
