import { PNG } from "pngjs";

import { commandFailureInfo, tailOf } from "./command-failure.js";
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
  /** Optional command surface used only for best-effort substrate fallbacks. */
  commands?: {
    run(command: string, options?: { requestTimeoutMs?: number; timeoutMs?: number }): Promise<{
      exitCode?: number;
      stderr?: string;
      stdout?: string;
    }>;
  };
  /** Optional file surface used to transfer typed text without shell-quoting it. */
  files?: {
    write(path: string, data: string | ArrayBuffer, options?: { requestTimeoutMs?: number; useOctetStream?: boolean }): Promise<unknown>;
  };
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
const TYPE_FALLBACK_TIMEOUT_MS = 15_000;

/** Coerce screenshot bytes (Uint8Array or Buffer) to a Node Buffer without copying when possible. */
function toBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The stage of the type -> clipboard-paste fallback chain that failed. Public-safe
 * (a path label, never typed text). Surfaced so a run bundle can tell app focus
 * from a missing clipboard utility from a failed paste keypress.
 */
export type CuaTypeFallbackPhase =
  | "clipboard-unavailable"
  | "clipboard-tempfile"
  | "clipboard-utility-missing"
  | "clipboard-command"
  | "paste-keypress";

/**
 * A `type` action that failed after both the primary write and the clipboard
 * paste fallback. Carries a redacted attempt chain (path labels only, never the
 * typed text), the failing phase, and a sanitized stderr/stdout tail when the
 * substrate produced one. The loop records `.name` + `.message` into the actor
 * trace notice, so the bundle proves WHERE the type stopped, not just that it did.
 */
export class CuaTypeFallbackError extends Error {
  readonly phase: CuaTypeFallbackPhase;
  readonly attemptChain: readonly string[];
  readonly stderrTail?: string;

  constructor(
    phase: CuaTypeFallbackPhase,
    attemptChain: readonly string[],
    stderrTail?: string,
    cause?: unknown,
  ) {
    const chain = attemptChain.join(" -> ");
    const suffix = stderrTail !== undefined && stderrTail.length > 0 ? ` (stderr: ${stderrTail})` : "";
    super(`type fallback failed at ${phase}: ${chain}${suffix}`);
    this.name = "CuaTypeFallbackError";
    this.phase = phase;
    this.attemptChain = attemptChain;
    if (stderrTail !== undefined && stderrTail.length > 0) this.stderrTail = stderrTail;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

type DesktopCommandResult = { exitCode?: number; stderr?: string; stdout?: string };

/** Map a clipboard-command exit code to a CuaTypeFallbackError phase and throw. */
function throwClipboardCommandFailure(
  exitCode: number | undefined,
  stderrTail: string,
  attemptChain: string[],
  cause?: unknown,
): never {
  if (exitCode === 127) {
    throw new CuaTypeFallbackError(
      "clipboard-utility-missing",
      [...attemptChain, "no xclip/xsel clipboard utility"],
      stderrTail,
      cause,
    );
  }
  throw new CuaTypeFallbackError(
    "clipboard-command",
    [
      ...attemptChain,
      exitCode === undefined ? "clipboard command errored" : `clipboard command failed (exit ${exitCode})`,
    ],
    stderrTail,
    cause,
  );
}

/**
 * Best-effort clipboard-paste fallback for a `type` action after the primary
 * `desktop.write` failed. Records each attempt into `attemptChain` (path labels
 * only) and throws a CuaTypeFallbackError naming the failing phase + a sanitized
 * stderr tail when the chain cannot complete. The typed text is transferred via a
 * temp file (never shell-quoted) and is never included in the chain or error.
 */
async function pasteTextViaClipboard(
  desktop: E2BDesktopLike,
  text: string,
  attemptChain: string[],
): Promise<void> {
  const files = desktop.files;
  const commands = desktop.commands;
  if (!files || !commands) {
    throw new CuaTypeFallbackError("clipboard-unavailable", [
      ...attemptChain,
      "clipboard fallback unavailable (no command/file surface)",
    ]);
  }

  const path = `/tmp/humanish-cua-type-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  try {
    await files.write(path, text, { requestTimeoutMs: TYPE_FALLBACK_TIMEOUT_MS });
  } catch (writeError) {
    throw new CuaTypeFallbackError(
      "clipboard-tempfile",
      [...attemptChain, "clipboard temp-file write failed"],
      undefined,
      writeError,
    );
  }

  const clipboardCommand = [
    "set -euo pipefail",
    "export DISPLAY=\"${DISPLAY:-:0}\"",
    `text_path=${shellSingleQuote(path)}`,
    "cleanup() { rm -f \"$text_path\"; }",
    "trap cleanup EXIT",
    // Try xclip, then fall back to xsel if xclip is absent OR fails; distinguish a
    // missing utility (exit 127) from a utility that ran but failed (exit 1) so the
    // caller can name the phase.
    "if command -v xclip >/dev/null 2>&1 && xclip -selection clipboard < \"$text_path\"; then",
    "  :",
    "elif command -v xsel >/dev/null 2>&1 && xsel --clipboard --input < \"$text_path\"; then",
    "  :",
    "elif command -v xclip >/dev/null 2>&1 || command -v xsel >/dev/null 2>&1; then",
    "  echo 'clipboard utility present but failed to set the clipboard' >&2",
    "  exit 1",
    "else",
    "  echo 'no xclip/xsel clipboard utility available for paste fallback' >&2",
    "  exit 127",
    "fi"
  ].join("\n");

  // The real @e2b/desktop Sandbox THROWS CommandExitError on any non-zero exit
  // (it does not return a non-zero exitCode), so the exit code + stderr must be
  // recovered from the thrown error. A structural fake that returns a non-zero
  // exitCode instead of throwing is also handled, so both shapes are covered.
  let runResult: DesktopCommandResult | undefined;
  let runError: unknown;
  try {
    runResult = await commands.run(clipboardCommand, {
      requestTimeoutMs: TYPE_FALLBACK_TIMEOUT_MS,
      timeoutMs: TYPE_FALLBACK_TIMEOUT_MS
    });
  } catch (error) {
    runError = error;
  }

  if (runError !== undefined) {
    const detail = commandFailureInfo(runError);
    throwClipboardCommandFailure(detail.exitCode, detail.stderrTail, attemptChain, runError);
  }
  if (runResult !== undefined && runResult.exitCode !== undefined && runResult.exitCode !== 0) {
    throwClipboardCommandFailure(runResult.exitCode, tailOf(runResult.stderr ?? runResult.stdout), attemptChain);
  }
  attemptChain.push("clipboard write ok");

  try {
    await desktop.press(["Control", "v"]);
  } catch (pressError) {
    throw new CuaTypeFallbackError(
      "paste-keypress",
      [...attemptChain, "paste keypress (Control+V) failed"],
      undefined,
      pressError,
    );
  }
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
      // Probe browser state before the screenshot so a deterministic stopWhen match
      // and its persisted frame describe the same settled surface as closely as the
      // desktop substrate allows.
      const browserState = await options.observeBrowserState?.().catch(() => undefined);
      const raw = await desktop.screenshot();
      const screenshot = toBuffer(raw);
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
        case "type": {
          const attemptChain: string[] = [];
          try {
            await desktop.write(action.text);
            return;
          } catch {
            // The primary write failed; record the path and try the clipboard
            // fallback, which throws a CuaTypeFallbackError naming the phase if it
            // also fails. (The write error carries no diagnostics beyond "it
            // threw"; the typed text is never recorded.)
            attemptChain.push("desktop.write failed");
          }
          await pasteTextViaClipboard(desktop, action.text, attemptChain);
          return;
        }
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
