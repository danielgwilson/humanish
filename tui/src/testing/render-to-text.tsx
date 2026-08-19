// A render harness for text goldens (#455).
//
// Deliberately in-repo rather than `ink-testing-library`, whose last publish was 2024 and which
// declares no `ink` peer at all — a stale dependency in the position of deciding whether our
// committed goldens are correct. It is about thirty lines to render into a fake TTY and read the
// frames back, and owning it means the harness can never disagree with the Ink version we ship.
//
// What this exercises that a component unit test cannot: real yoga layout at a real width. Every
// wrapping, truncation and alignment bug lives there, and every one of them is invisible until
// something measures characters.

import { render } from "ink";
import { PassThrough } from "node:stream";
import type React from "react";

export interface RenderedFrames {
  /** Every frame Ink wrote, escape codes stripped, in order. */
  frames: string[];
  /**
   * The frame that satisfied the wait predicate — NOT simply the last one. Ink's final writes are
   * cursor control that strips to an empty string, so "the last frame" is usually blank and a
   * golden taken from it would be empty and pass.
   */
  last: string;
  /** Send a keystroke, then wait for the frame it produces. Keys are in `KEY`. */
  press(input: string, until?: (frame: string) => boolean): Promise<string>;
  unmount(): void;
}

/** The escape sequences a terminal actually sends, named so tests read like the interaction. */
export const KEY = {
  down: "\u001B[B",
  up: "\u001B[A",
  enter: "\r",
  escape: "\u001B",
  right: "\u001B[C",
  left: "\u001B[D"
} as const;

/**
 * Strip SGR colour and cursor control so a golden compares TEXT, not terminal capabilities.
 * Written with explicit \\u001B escapes: a literal ESC byte in source is invisible in review and
 * silently lost by any tool that normalizes control characters.
 */
export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001B[()][A-Za-z0-9]/g, "");
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    setRawMode: () => unknown;
    ref: () => unknown;
    unref: () => unknown;
  };
  // Ink's `useInput` enables raw mode and then ref/unrefs the handle to control whether the process
  // stays alive. A PassThrough has none of that, and the missing method surfaces as a render crash
  // INSIDE the frame rather than as a thrown error — which is exactly how it presented.
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

function fakeStdout(columns: number, rows: number, frames: string[]): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  stream.write = ((chunk: string | Uint8Array): boolean => {
    frames.push(stripAnsi(String(chunk)));
    return true;
  }) as NodeJS.WriteStream["write"];
  return stream;
}

export interface RenderOptions {
  columns?: number;
  rows?: number;
  /** Resolves when this predicate sees a frame; the default waits for any non-empty frame. */
  until?: (frame: string) => boolean;
  timeoutMs?: number;
}

/**
 * Render a tree at a fixed terminal size and wait for the frame that matters.
 *
 * Waiting on a PREDICATE rather than a timer is what keeps these tests off the flaky list: a
 * surface that loads data renders "reading…" first, and a fixed sleep captures whichever frame the
 * scheduler happened to reach.
 */
export async function renderToText(
  node: React.ReactElement,
  options: RenderOptions = {}
): Promise<RenderedFrames> {
  const columns = options.columns ?? 80;
  const rows = options.rows ?? 24;
  const frames: string[] = [];
  const stdout = fakeStdout(columns, rows, frames);
  const stdin = fakeStdin();
  const instance = render(node, {
    stdin,
    stdout,
    patchConsole: false,
    exitOnCtrlC: false,
    // Ink decides interactivity from `is-in-ci` AND stdout.isTTY, and when it decides
    // non-interactive it writes ONLY THE FINAL FRAME AT UNMOUNT — no erase sequences, no
    // intermediate renders. This harness exists to observe frames as they change and to send keys
    // between them, so under CI every render test would wait forever for a frame that never comes.
    // The environment variable describes the machine, not this stream: we built a TTY above, so we
    // say so rather than letting an unrelated env var decide.
    interactive: true
  });

  const wanted = options.until ?? ((frame: string) => frame.trim().length > 0);
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  let matched: string | undefined;
  for (;;) {
    matched = [...frames].reverse().find((frame) => wanted(frame));
    if (matched !== undefined) break;
    if (Date.now() > deadline) {
      instance.unmount();
      // Print every frame, not just the last: the last is nearly always Ink's blank teardown write,
      // which tells you nothing about why the predicate never matched.
      throw new Error(
        `renderToText: no frame matched within the timeout. Frames were:\n${
          frames.length === 0 ? "(nothing rendered)" : frames.map((frame, index) => `--- ${index} ---\n${frame}`).join("\n")
        }`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const waitForFrame = async (predicate: (frame: string) => boolean, from: number): Promise<string> => {
    const limit = Date.now() + (options.timeoutMs ?? 2_000);
    for (;;) {
      const found = frames.slice(from).reverse().find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > limit) {
        throw new Error(
          `renderToText: no frame after the keypress matched. Frames since:\n${frames
            .slice(from)
            .map((frame, index) => `--- ${index} ---\n${frame}`)
            .join("\n")}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    frames,
    last: matched,
    press: async (input, until) => {
      const from = frames.length;
      (stdin as unknown as { write(chunk: string): void }).write(input);
      // A keypress that changes nothing would hang forever on a "frame differs" predicate, so the
      // default waits for any non-blank frame written after the key — Ink re-renders on input.
      return waitForFrame(until ?? ((frame) => frame.trim().length > 0), from);
    },
    unmount: () => instance.unmount()
  };
}

/** Trim trailing whitespace per line so a golden is not hostage to padding. */
export function normalizeFrame(frame: string): string {
  return frame
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
