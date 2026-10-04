import { Box, Text } from "ink";
import React from "react";

import { PALETTE } from "./palette.js";
import { color } from "./text-props.js";
import { runDisplay, type RunDisplay, type RunDisplayFacts } from "../../src/run/display.js";
import { terminalRendersUnicode } from "../../src/routes/terminal/encoding.js";

/**
 * The chrome every screen sits in.
 *
 * Two things this fixes, both visible the moment the surface met a real terminal:
 *
 * 1. Width is capped. Ink lays out to the terminal's full width, so on a 150-column window the
 *    header pinned "humanish" to the left edge and the version to the right with a canyon between
 *    them, and every row became a pair of distant columns. Terminals get arbitrarily wide; reading
 *    does not get better past a point. Content is capped and left-aligned, so a wide terminal gets
 *    margin instead of sprawl.
 *
 * 2. The header says where you are and what is happening. The wordmark on the left, and on the
 *    right the thing a stakeholder actually wants at a glance: the project, and whether anyone is
 *    working in it right now.
 */
const CONTENT_MAX_COLUMNS = 96;

/** How wide the content may actually be, given the terminal. */
export function contentWidth(columns: number): number {
  return Math.max(20, Math.min(CONTENT_MAX_COLUMNS, columns));
}

export interface FrameProps {
  /** Terminal width; the frame caps its own content. */
  columns: number;
  /** Right-hand header text: the project, and what is live in it. */
  context: string | undefined;
  /** Breadcrumb under the wordmark, e.g. `‹ studies / observer-live-check`. */
  breadcrumb: string | undefined;
  /** The key legend, already written for this screen. */
  hints: string;
  children: React.ReactNode;
}

export function Frame({
  columns,
  context,
  breadcrumb,
  hints,
  children,
}: FrameProps): React.ReactElement {
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
 * A live row needs to look live: a static list of studies where one says "running" reads as stale
 * data, and the thing that says otherwise is motion.
 */
// Braille spinner where the terminal can render it, ASCII where it cannot. A participant at a
// stock desktop read our em dash back as `���` (labs/tui-self-study.yaml); every glyph on this
// surface has the same exposure, and a spinner made of replacement boxes is worse than a plain one.
const SPINNER_FRAMES = terminalRendersUnicode()
  ? (["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const)
  : (["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"] as const);

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[Math.abs(Math.floor(tick)) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

/** The selection cursor, and the gutter that keeps unselected rows from shifting under it. */
export function gutter(active: boolean): string {
  return active ? (terminalRendersUnicode() ? "❯" : ">") : " ";
}

/** A run as the glyph reads it: its display facts, and the spinner's tick while it runs. */
type GlyphRun = RunDisplayFacts & { tick?: number };

/**
 * Verdict glyphs: a run's outcome readable before its text is. runDisplay decides the state, as on
 * every other surface: a check mark only for a run that passed, a flag for one that failed, was
 * blocked, timed out, ended with no verdict or was interrupted, and a dot for a dry run.
 */
export function verdictGlyph(run: GlyphRun): string {
  const { state, tone } = runDisplay(run);
  if (state === "running") return spinnerFrame(run.tick ?? 0);
  const unicode = terminalRendersUnicode();
  if (tone === "pass") return unicode ? "✓" : "+";
  if (tone === "fail" || tone === "warn") return unicode ? "⚑" : "!";
  return unicode ? "·" : "-";
}

const TONE_COLORS: Record<RunDisplay["tone"], string | undefined> = {
  live: PALETTE.ok,
  fail: PALETTE.bad,
  warn: PALETTE.warn,
  pass: undefined,
  neutral: undefined,
};

/** Convenience so callers spread colour without repeating the guard. */
export const glyphColor = (run: RunDisplayFacts): { color?: string } =>
  color(TONE_COLORS[runDisplay(run).tone]);
