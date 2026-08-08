// #383: the no-progress backstop must not end a lane that is working.
//
// What went wrong. The backstop's only input was a 16x16 grayscale frame hash at 2 bits per cell,
// with no contrast normalization. On a light-themed web app the area-average of nearly every cell
// landed at the top of the range: a measured live run had 93% of the 256 cells pinned to the top
// level and the two darkest levels never used at all. The hash was effectively constant, so 9
// visibly different consecutive frames — one auto-named table becoming two named tables with fields
// and an expanded editor panel — produced ONE identical signature. The backstop read that as a stuck
// agent, ended the lane as `gave_up`, and recorded the run as 0/2 passed while the agent was a
// foreign key away from finishing its mission.
//
// Two things are pinned here. The signature must SEE a widget-sized change on a light UI, and a
// stale frame alone must never be enough to call an agent stuck — that now also requires the agent
// to be repeating itself.
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { perceptualSignature } from "../src/e2b-desktop-executor.js";
import { actionFingerprint, type CuaAction } from "../src/computer-use.js";

/**
 * A light-themed app frame at desktop resolution: near-white page, a grey sidebar, and `rows`
 * sidebar entries. This reproduces the shape that defeated the old hash — the only thing that
 * changes between frames is a small amount of dark text in a large light field.
 */
function lightUiFrame(rows: number, options: { panel?: boolean } = {}): Buffer {
  const width = 1440;
  const height = 950;
  const png = new PNG({ width, height });
  const put = (x: number, y: number, v: number): void => {
    const i = (y * width + x) * 4;
    png.data[i] = v;
    png.data[i + 1] = v;
    png.data[i + 2] = v;
    png.data[i + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      put(x, y, x < 380 ? 246 : 252); // sidebar slightly greyer than the canvas
    }
  }
  // Each sidebar row is a band of dark text ~20px tall — a realistic widget-sized change.
  for (let r = 0; r < rows; r += 1) {
    const top = 300 + r * 52;
    for (let y = top; y < top + 20 && y < height; y += 1) {
      for (let x = 40; x < 300; x += 1) put(x, y, 40);
    }
  }
  // An expanded editor panel: another modest dark region, as opening a form would produce.
  if (options.panel) {
    for (let y = 560; y < 620; y += 1) {
      for (let x = 40; x < 340; x += 1) put(x, y, 70);
    }
  }
  return PNG.sync.write(png);
}

describe("perceptualSignature on a light-themed UI (#383)", () => {
  it("sees a sidebar gaining a row — the change the old hash was blind to", () => {
    const oneRow = perceptualSignature(lightUiFrame(1));
    const twoRows = perceptualSignature(lightUiFrame(2));
    expect(oneRow).not.toBe(twoRows);
  });

  it("sees a panel opening, and distinguishes every step of a realistic edit sequence", () => {
    const frames = [
      lightUiFrame(1),
      lightUiFrame(2),
      lightUiFrame(2, { panel: true }),
      lightUiFrame(3, { panel: true })
    ].map(perceptualSignature);
    // The measured failure was 9 distinct frames collapsing to 1 signature. Every step here differs.
    expect(new Set(frames).size).toBe(frames.length);
  });

  it("spans the full quantization range on a light frame, which is what the old hash never did", () => {
    const levels: number[] = [];
    for (const ch of perceptualSignature(lightUiFrame(2, { panel: true }))) levels.push(Number.parseInt(ch, 16));

    // The measured failure was a hash confined to the TOP of its range: 93% of cells at the maximum
    // level and the two darkest levels never occupied at all, which is why a dark-on-light change
    // could not move it. Contrast normalization anchors each frame's own darkest content at 0 and its
    // lightest at the maximum, so the levels a change has to cross are actually available.
    //
    // (A mostly-uniform frame still has most CELLS at one level — that is the image being uniform,
    // not the hash being blind, so the property to assert is the range, not the distribution.)
    expect(Math.min(...levels)).toBe(0);
    expect(Math.max(...levels)).toBe(15);
    expect(new Set(levels).size).toBeGreaterThan(2);
  });

  it("still reports an identical frame as identical, and survives an undecodable one", () => {
    expect(perceptualSignature(lightUiFrame(2))).toBe(perceptualSignature(lightUiFrame(2)));
    expect(perceptualSignature(Buffer.alloc(0))).toBe(perceptualSignature(Buffer.from("not a png")));
  });
});

describe("actionFingerprint (the corroboration input, #383)", () => {
  const click = (x: number, y: number): CuaAction => ({ kind: "click", x, y, button: "left" });

  it("treats re-clicking the same control as a repeat and a different control as new", () => {
    expect(actionFingerprint([click(200, 400)])).toBe(actionFingerprint([click(203, 402)]));
    expect(actionFingerprint([click(200, 400)])).not.toBe(actionFingerprint([click(900, 400)]));
  });

  it("never includes typed text — only its length, so it cannot become a keylogger", () => {
    const secret = actionFingerprint([{ kind: "type", text: "hunter2!" }]);
    expect(secret).not.toContain("hunter2");
    expect(secret).toBe(actionFingerprint([{ kind: "type", text: "12345678" }]));
  });

  it("distinguishes an agent working from an agent repeating itself", () => {
    const working = [
      actionFingerprint([click(100, 200)]),
      actionFingerprint([click(400, 300)]),
      actionFingerprint([{ kind: "keypress", keys: ["ctrl", "a"] }])
    ];
    expect(new Set(working).size).toBe(3);

    const stuck = [click(301, 486), click(300, 487), click(302, 485)].map((a) => actionFingerprint([a]));
    expect(new Set(stuck).size).toBe(1);
  });
});
