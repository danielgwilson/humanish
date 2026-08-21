// The bundle's only export surface (#455). `humanish tui` imports exactly this.

import { render } from "ink";
import React from "react";

import type { StartTui, TuiOptions } from "../../src/tui-contract.js";
import { forTerminal, terminalRendersUnicode } from "../../src/terminal-encoding.js";
import { App } from "./app.js";

/**
 * A stdout that a non-UTF-8 terminal can read.
 *
 * ONE choke point instead of a fallback at every glyph. Ink composes frames from dozens of strings
 * across every screen, and a surface where most glyphs degrade and three do not is worse than
 * either extreme — it looks broken in a way that reads as a bug in the tool. A participant at a
 * stock desktop is where this came from: they read `humanish ��� run realistic synthetic personas`
 * off the screen and reported it (labs/tui-self-study.yaml).
 *
 * Only the TUI can do this safely: the CLI transcodes for a TTY and never for a pipe, because a
 * pipe carries bytes to a program. `humanish tui` refuses a non-TTY outright, so here the
 * destination is always a person's font.
 */
function encodeFor(stdout: TuiOptions["stdout"]): TuiOptions["stdout"] {
  if (terminalRendersUnicode()) return stdout;
  const wrapped = Object.create(stdout) as TuiOptions["stdout"];
  wrapped.write = ((chunk: unknown, ...rest: unknown[]): boolean =>
    (stdout.write as (value: unknown, ...args: unknown[]) => boolean)(
      typeof chunk === "string" ? forTerminal(chunk) : chunk,
      ...rest
    )) as typeof stdout.write;
  return wrapped;
}

export const startTui: StartTui = async (options: TuiOptions): Promise<number> => {
  let ready: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const stdout = encodeFor(options.stdout);
  const instance = render(<App options={options} onReady={ready} />, {
    stdin: options.stdin,
    stdout,
    // Ink's own console patching rewrites stdout behind the app. humanish writes its logs to files
    // and its results to stdout through CliIo, so there is nothing to patch and patching would
    // only add a way for a stray write to corrupt the frame.
    patchConsole: false,
    exitOnCtrlC: true,
    // The CLI has already refused unless BOTH streams are real TTYs, so by the time this runs an
    // interactive terminal is established fact. Ink would otherwise consult `is-in-ci` and drop to
    // writing one frame at unmount — turning a human's session on a CI runner into a dead screen
    // because of an environment variable that says nothing about whether THIS invocation has a
    // terminal.
    interactive: true
  });

  if (options.exitAfterFirstFrame === true) {
    // Smoke path: prove the surface mounts, renders real data, and tears down — without a human.
    // The extra turn lets Ink's writer flush the committed frame before the tree goes away.
    await firstFrame;
    await new Promise((resolve) => setImmediate(resolve));
    instance.unmount();
  }

  try {
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    // A crash inside the render tree must still leave the terminal usable, and must say what
    // happened rather than exiting silently on a cleared screen.
    instance.unmount();
    options.stdout.write(`humanish tui exited: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
