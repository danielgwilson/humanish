import { Box, Text } from "ink";
import React from "react";

import { PALETTE } from "./palette.js";
import { color } from "./text-props.js";

/**
 * The chrome every screen sits in (#455 rev 8).
 *
 * TWO THINGS THIS FIXES, both visible the moment the surface met a real terminal:
 *
 * 1. WIDTH IS CAPPED. Ink lays out to the terminal's full width, so on a 150-column window the
 *    header pinned "humanish" to the left edge and the version to the right with a canyon between
 *    them, and every row became a pair of distant columns. Terminals get arbitrarily wide; reading
 *    does not get better past a point. Content is capped and left-aligned, so a wide terminal gets
 *    margin instead of sprawl.
 *
 * 2. THE HEADER SAYS WHERE YOU ARE AND WHAT IS HAPPENING. The wordmark on the left, and on the
 *    right the thing a stakeholder actually wants at a glance — the project, and whether anyone is
 *    working in it right now.
 */
export const CONTENT_MAX_COLUMNS = 96;

/** How wide the content may actually be, given the terminal. */
export function contentWidth(columns: number): number {
  return Math.max(20, Math.min(CONTENT_MAX_COLUMNS, columns));
}

export interface FrameProps {
  /** Terminal width; the frame caps its own content. */
  columns: number;
  /** Right-hand header text: the project, and what is live in it. */
  context: string | undefined;
  /** Breadcrumb under the wordmark, e.g. `‹ labs / observer-live-check`. */
  breadcrumb: string | undefined;
  /** The key legend, already written for THIS screen. */
  hints: string;
  children: React.ReactNode;
}

export function Frame({ columns, context, breadcrumb, hints, children }: FrameProps): React.ReactElement {
  const width = contentWidth(columns);
  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text bold>human(ish)</Text>
        <Box flexGrow={1} />
        {context === undefined ? null : (
          <Text dimColor wrap="truncate-start">
            {context}
          </Text>
        )}
      </Box>
      {breadcrumb === undefined ? null : (
        <Text dimColor wrap="truncate-start">
          {breadcrumb}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hints}</Text>
      </Box>
    </Box>
  );
}

/**
 * The braille spinner, advanced by the caller's tick.
 *
 * A live row needs to LOOK live: a static list of labs where one says "running" reads as stale
 * data, and the thing that says otherwise is motion.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[Math.abs(Math.floor(tick)) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

/** The selection cursor, and the gutter that keeps unselected rows from shifting under it. */
export function gutter(active: boolean): string {
  return active ? "❯" : " ";
}

/** Verdict glyphs — a run's outcome readable before its text is. */
export function verdictGlyph(args: { liveness: string; verdict?: string; tick?: number }): string {
  if (args.liveness === "running") return spinnerFrame(args.tick ?? 0);
  if (args.liveness === "interrupted") return "⚑";
  if (args.verdict === "fail") return "⚑";
  if (args.verdict === undefined) return "·";
  return "✓";
}

export function verdictColor(args: { liveness: string; verdict?: string }): string | undefined {
  if (args.liveness === "running") return PALETTE.ok;
  if (args.liveness === "interrupted") return PALETTE.warn;
  if (args.verdict === "fail") return PALETTE.bad;
  return undefined;
}

/** Convenience so callers spread colour without repeating the guard. */
export const glyphColor = (args: { liveness: string; verdict?: string }): { color?: string } =>
  color(verdictColor(args));
