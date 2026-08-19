// The bundle's only export surface (#455). `humanish tui` imports exactly this.

import { render } from "ink";
import React from "react";

import type { StartTui, TuiOptions } from "../../src/tui-contract.js";
import { App } from "./app.js";

export const startTui: StartTui = async (options: TuiOptions): Promise<number> => {
  let ready: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const instance = render(<App options={options} onReady={ready} />, {
    stdin: options.stdin,
    stdout: options.stdout,
    // Ink's own console patching rewrites stdout behind the app. humanish writes its logs to files
    // and its results to stdout through CliIo, so there is nothing to patch and patching would
    // only add a way for a stray write to corrupt the frame.
    patchConsole: false,
    exitOnCtrlC: true
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
