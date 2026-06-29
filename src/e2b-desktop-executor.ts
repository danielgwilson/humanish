import { PNG } from "pngjs";

import type { CuaAction, CuaExecutor, CuaObservation } from "./computer-use.js";

// The DESKTOP side of the computer-use loop: a CuaExecutor (from
// src/computer-use.ts) backed by an E2B desktop sandbox. It mirrors the
// pure-logic-plus-injectable-shim pattern used by the OpenAI provider in
// src/openai-responses-cu.ts: all of the executor's behavior is driven through a
// narrow injected port (E2BDesktopLike), so the whole module is fully testable in
// CI with a fake desktop that records calls (no SDK, no sandbox, no spend). The
// real @e2b/desktop Sandbox is passed in at the live call site later.
//
// E2BDesktopLike is a faithful STRUCTURAL SUBSET of the real @e2b/desktop Sandbox
// (version 2.2.3). Each method name and signature below matches the real class so
// a real Sandbox instance satisfies this interface with no adapter:
//
//   screenshot(): Promise<Uint8Array>            // default/'bytes' overload
//   leftClick(x?, y?): Promise<void>
//   rightClick(x?, y?): Promise<void>
//   middleClick(x?, y?): Promise<void>
//   doubleClick(x?, y?): Promise<void>
//   moveMouse(x, y): Promise<void>
//   scroll(direction?: 'up' | 'down', amount?: number): Promise<void>
//   write(text, options?): Promise<void>         // the text-typing method
//   press(key: string | string[]): Promise<void>
//   drag([x1, y1], [x2, y2]): Promise<void>      // tuple endpoints, not a path
//   wait(ms): Promise<void>
//
// Deviations forced by the real SDK shape (vs the executor spec):
//  - scroll is VERTICAL ONLY: scroll(direction, amount) with no coordinates, so a
//    CuaAction scroll's dx (horizontal) is ignored and there is no cursor move
//    before it (the SDK does not take a position). dy maps to direction + amount.
//  - drag takes two coordinate tuples (from, to), not an N-point path, so we drag
//    from the FIRST point of action.path to the LAST and drop intermediate points.
//  - write is the typing method (there is no `type` method); press is the key
//    method (there is no `keyPress`), and press accepts the keys array directly.
//
// Public-safety: observe() returns the RAW screenshot bytes in
// CuaObservation.screenshot. That is correct: the loop redacts every frame
// through RedactionHooks before persisting (see runComputerUseLoop). This module
// must NOT redact here and must NEVER log screenshots or actions (no console.*).
// The stateSignature is a coarse, non-reversible perceptual hash, safe to expose.

/**
 * The minimal slice of the real @e2b/desktop Sandbox the executor depends on. A
 * structural subset of the real class (v2.2.3), so a real Sandbox satisfies it
 * with no adapter. Methods are typed to return `Promise<void> | void` (and the
 * screenshot bytes likewise) so a synchronous fake also satisfies the port; the
 * executor awaits every call, which is correct for both sync and async returns.
 */
export interface E2BDesktopLike {
  /** Capture the current desktop frame as PNG bytes (default/'bytes' overload). */
  screenshot(): Promise<Uint8Array | Buffer> | Uint8Array | Buffer;
  /** Left click, optionally moving to (x, y) first. */
  leftClick(x?: number, y?: number): Promise<void> | void;
  /** Right click, optionally moving to (x, y) first. */
  rightClick(x?: number, y?: number): Promise<void> | void;
  /** Middle click, optionally moving to (x, y) first. */
  middleClick(x?: number, y?: number): Promise<void> | void;
  /** Double left click, optionally moving to (x, y) first. */
  doubleClick(x?: number, y?: number): Promise<void> | void;
  /** Move the mouse to the given coordinates. */
  moveMouse(x: number, y: number): Promise<void> | void;
  /** Scroll the mouse wheel vertically by amount ticks in a direction. */
  scroll(direction?: "up" | "down", amount?: number): Promise<void> | void;
  /** Write text at the current cursor position (the SDK's typing method). */
  write(text: string): Promise<void> | void;
  /** Press a key or chord (the SDK's key method); accepts the keys array. */
  press(key: string | string[]): Promise<void> | void;
  /** Drag from one coordinate tuple to another. */
  drag(from: [number, number], to: [number, number]): Promise<void> | void;
  /** Wait for the given number of milliseconds. */
  wait(ms: number): Promise<void> | void;
}

export interface E2BDesktopExecutorOptions {
  /** Fallback wait when a wait action carries no ms. Default 500. */
  defaultWaitMs?: number;
  /**
   * Pixels of CuaAction scroll dy per one SDK scroll tick. The executor maps
   * abs(dy) / scrollAmountPerTick to the SDK's integer `amount` (floored at 1 for
   * any nonzero scroll). Default 100.
   */
  scrollAmountPerTick?: number;
  /**
   * Optional runtime-only browser state probe. Used for deterministic stopWhen guards. The loop
   * never persists raw URL/title/text; it only uses them in memory to decide whether to stop.
   */
  observeBrowserState?: () => Promise<Pick<CuaObservation, "url" | "title" | "text">>;
}

const DEFAULT_WAIT_MS = 500;
const DEFAULT_SCROLL_AMOUNT_PER_TICK = 100;

/** Coerce screenshot bytes (Uint8Array or Buffer) to a Node Buffer without copying when possible. */
function toBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/**
 * Create a CuaExecutor backed by an E2B desktop (or any structural E2BDesktopLike,
 * e.g. a CI fake). observe() captures a frame and computes its perceptual
 * signature; execute() dispatches one CuaAction to the matching desktop method.
 * Every desktop call is awaited so sync and async implementations both work. No
 * screenshot or action is ever logged.
 */
export function createE2BDesktopExecutor(
  desktop: E2BDesktopLike,
  options: E2BDesktopExecutorOptions = {}
): CuaExecutor {
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS;
  const scrollAmountPerTick = options.scrollAmountPerTick ?? DEFAULT_SCROLL_AMOUNT_PER_TICK;

  return {
    async observe(): Promise<CuaObservation> {
      const raw = await desktop.screenshot();
      const screenshot = toBuffer(raw);
      const browserState = await options.observeBrowserState?.().catch(() => undefined);
      return {
        screenshot,
        stateSignature: perceptualSignature(screenshot),
        ...(browserState?.url === undefined ? {} : { url: browserState.url }),
        ...(browserState?.title === undefined ? {} : { title: browserState.title }),
        ...(browserState?.text === undefined ? {} : { text: browserState.text })
      };
    },

    async execute(action: CuaAction): Promise<void> {
      switch (action.kind) {
        case "click": {
          const button = action.button ?? "left";
          if (button === "right") {
            await desktop.rightClick(action.x, action.y);
          } else if (button === "middle") {
            await desktop.middleClick(action.x, action.y);
          } else {
            await desktop.leftClick(action.x, action.y);
          }
          return;
        }
        case "double_click":
          await desktop.doubleClick(action.x, action.y);
          return;
        case "move":
          await desktop.moveMouse(action.x, action.y);
          return;
        case "scroll": {
          // The real SDK scroll is vertical only and takes no position, so move the
          // cursor to the scroll point first (the action targets a specific spot;
          // scrolling at the wrong cursor position would scroll the wrong panel).
          // dx (horizontal) has no SDK target and is ignored; a zero dy is a no-op.
          if (action.dy === 0) return;
          await desktop.moveMouse(action.x, action.y);
          const direction = action.dy > 0 ? "down" : "up";
          const amount = Math.max(1, Math.round(Math.abs(action.dy) / scrollAmountPerTick));
          await desktop.scroll(direction, amount);
          return;
        }
        case "type":
          await desktop.write(action.text);
          return;
        case "keypress":
          // The SDK press() accepts a string[] directly; pass the keys through so
          // a chord (e.g. ["Control", "a"]) is pressed together, not in sequence.
          await desktop.press(action.keys);
          return;
        case "drag": {
          // The SDK drag takes two endpoints, not an N-point path: drag from the
          // first to the last point. 0 points is a safe no-op; 1 point has no
          // distinct endpoint, so it is also a no-op (no spurious click/move).
          const path = action.path;
          if (path.length < 2) return;
          const from = path[0];
          const to = path[path.length - 1];
          if (from === undefined || to === undefined) return;
          await desktop.drag([from.x, from.y], [to.x, to.y]);
          return;
        }
        case "wait":
          await desktop.wait(action.ms ?? defaultWaitMs);
          return;
        case "screenshot":
          // No-op: the loop calls observe() separately to capture each frame, so
          // capturing here would double-capture. Leave the desktop untouched.
          return;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Perceptual signature.
//
// A coarse, deterministic hash of a frame for no-progress detection in the loop.
// It is robust to small noise (a blinking cursor, a single changed clock digit)
// because it area-averages the frame down to a 16x16 grayscale grid and then
// quantizes each cell to 4 levels (2 bits). Two visually-identical frames produce
// the same signature; a clearly different frame differs. It is NOT reversible to
// the image, so exposing it (e.g. in a trace) is public-safe. On any decode
// failure it returns a stable fallback so two unreadable frames compare equal.
// ---------------------------------------------------------------------------

const SIGNATURE_GRID = 16;
const SIGNATURE_FALLBACK = "unreadable";

/**
 * A coarse perceptual hash of a PNG frame for no-progress detection. Decodes the
 * PNG, area-averages it to a SIGNATURE_GRID x SIGNATURE_GRID grayscale grid,
 * quantizes each cell to 2 bits (gray >> 6, four levels), and packs the
 * (SIGNATURE_GRID^2) two-bit cells into a compact hex string. Deterministic (no
 * Date, no random). Returns SIGNATURE_FALLBACK on any decode failure so two
 * unreadable frames compare equal.
 */
export function perceptualSignature(pngBytes: Buffer | Uint8Array): string {
  let cells: number[];
  try {
    const source = Buffer.isBuffer(pngBytes) ? pngBytes : Buffer.from(pngBytes);
    if (source.length === 0) return SIGNATURE_FALLBACK;
    const decoded = PNG.sync.read(source);
    const srcW = decoded.width;
    const srcH = decoded.height;
    if (!srcW || !srcH) return SIGNATURE_FALLBACK;
    cells = quantizedGrid(decoded.data, srcW, srcH);
  } catch {
    return SIGNATURE_FALLBACK;
  }
  return packCells(cells);
}

/** Area-average an RGBA buffer to a grid of 2-bit (0..3) grayscale cells. */
function quantizedGrid(data: Buffer, srcW: number, srcH: number): number[] {
  const cells: number[] = [];
  const xRatio = srcW / SIGNATURE_GRID;
  const yRatio = srcH / SIGNATURE_GRID;
  for (let gy = 0; gy < SIGNATURE_GRID; gy += 1) {
    const sy0 = Math.floor(gy * yRatio);
    const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.floor((gy + 1) * yRatio)));
    for (let gx = 0; gx < SIGNATURE_GRID; gx += 1) {
      const sx0 = Math.floor(gx * xRatio);
      const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.floor((gx + 1) * xRatio)));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const si = (sy * srcW + sx) * 4;
          const r = data[si] ?? 0;
          const g = data[si + 1] ?? 0;
          const b = data[si + 2] ?? 0;
          sum += Math.round((r + g + b) / 3);
          n += 1;
        }
      }
      const gray = n ? Math.round(sum / n) : 0;
      // Quantize 0..255 to four levels (0..3). Clamp the 255 edge so it stays in
      // range (255 >> 6 === 3 already, but Math.min guards any rounding surprise).
      cells.push(Math.min(3, gray >> 6));
    }
  }
  return cells;
}

/** Pack 2-bit cells (4 per hex... actually 2 per byte) into a compact hex string. */
function packCells(cells: number[]): string {
  // Pack four 2-bit cells per byte, then hex-encode. SIGNATURE_GRID^2 cells.
  const bytes = Buffer.alloc(Math.ceil(cells.length / 4));
  for (let i = 0; i < cells.length; i += 1) {
    const byteIndex = i >> 2;
    const shift = (i & 3) * 2;
    const value = (cells[i] ?? 0) & 3;
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (value << shift);
  }
  return bytes.toString("hex");
}
