import { randomUUID } from "node:crypto";

import type { E2BDesktopLike } from "./e2b-desktop-executor.js";

/** 2048 scalar values at 75ms leave margin inside the 180s native process bound. */
export const NATIVE_TYPE_MAX_CODE_POINTS = 2048;
export const NATIVE_TYPE_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;

export type CuaTypeInputPhase = "invalid-text" | "preparation" | "transfer" | "input-uncertain" | "cleanup";

/**
 * Never a CommandExitError: input may have happened before a command failed.
 * No raw substrate errors, payload, or numeric exitCode enter this public notice.
 */
export class CuaTypeInputError extends Error {
  constructor(
    readonly phase: CuaTypeInputPhase,
    readonly cleanup: "not-created" | "confirmed" | "unconfirmed" = "not-created",
  ) {
    super(phase === "invalid-text"
      ? `Typing requires at most ${NATIVE_TYPE_MAX_CODE_POINTS} Unicode scalar values without NUL; no input was sent.`
      : phase === "input-uncertain"
        ? `Typing completion is uncertain; input may be partial. No replay was sent. Temporary-file cleanup: ${cleanup}.`
        : phase === "cleanup"
          ? "Typing returned, but temporary-file cleanup was not confirmed. Do not repeat the input."
          : `Typing stopped during ${phase}; no input was sent. Temporary-file cleanup: ${cleanup}.`);
    this.name = "CuaTypeInputError";
  }
}

// Shared seats and new executor instances must see the same unresolved typing.
// An abort closes admission synchronously even while the command promise is pending.
const desktopTyping = new WeakMap<object, { unsafe: boolean }>();

export function hasUnsettledDesktopTyping(desktop: object): boolean {
  return desktopTyping.has(desktop);
}

export function assertDesktopInputReady(desktop: object): void {
  if (hasUnsettledDesktopTyping(desktop)) throw new CuaTypeInputError("input-uncertain");
}

/** Begin immediately before input dispatch; only a clean, non-aborted acknowledgment clears it. */
export function beginDesktopTyping(desktop: object, signal?: AbortSignal): (acknowledged: boolean) => void {
  signal?.throwIfAborted();
  assertDesktopInputReady(desktop);
  const state = { unsafe: false };
  desktopTyping.set(desktop, state);
  const onAbort = (): void => { state.unsafe = true; };
  signal?.addEventListener("abort", onAbort, { once: true });
  return (acknowledged): void => {
    if (!acknowledged || signal?.aborted) state.unsafe = true;
    signal?.removeEventListener("abort", onAbort);
    if (!state.unsafe) desktopTyping.delete(desktop);
  };
}

function validateNativeText(text: string): void {
  let count = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff) || ++count > NATIVE_TYPE_MAX_CODE_POINTS) {
      throw new CuaTypeInputError("invalid-text");
    }
  }
}

/**
 * An explicit Linux/X11 capability for managed E2B desktops, not a generic port fallback.
 * Text is file data. Only an owned UUID path enters shell commands. The GNU timeout
 * bounds the native process group even if the client disconnects; abort only closes
 * admission and does not promise that already admitted keystrokes stop immediately.
 */
export async function typeTextNative(
  desktop: Pick<E2BDesktopLike, "commands" | "files">,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  assertDesktopInputReady(desktop);
  validateNativeText(text);
  if (text.length === 0) return;
  const { commands, files } = desktop;
  if (!commands || !files) throw new CuaTypeInputError("preparation");

  const directory = `/tmp/humanish-cua-type-${randomUUID()}`;
  const file = `${directory}/input.txt`;
  // These paths contain no caller-controlled characters.
  const cleanupCommand = [
    "set -eu",
    `text_dir='${directory}'`,
    "test ! -L \"$text_dir\"",
    "if test -d \"$text_dir\"; then",
    "  rm -f -- \"$text_dir/input.txt\"",
    "  rmdir -- \"$text_dir\"",
    "fi",
  ].join("\n");
  const preparation = [
    "set -euo pipefail",
    "command -v xdotool >/dev/null",
    "case \"$(timeout --version)\" in *'GNU coreutils'*) ;; *) exit 1 ;; esac",
    "test \"$(LC_ALL=C.UTF-8 locale charmap)\" = UTF-8",
    "umask 077",
    `mkdir -m 700 -- '${directory}'`,
  ].join("\n");
  const inputCommand = [
    "set -euo pipefail",
    "export DISPLAY=\"${DISPLAY:-:0}\"",
    `text_dir='${directory}'`,
    `text_path='${file}'`,
    "trap 'rm -f -- \"$text_path\"; rmdir -- \"$text_dir\" 2>/dev/null || true' EXIT",
    "test ! -L \"$text_dir\" && test ! -L \"$text_path\"",
    "chmod 600 -- \"$text_path\"",
    `LC_ALL=C.UTF-8 timeout --signal=TERM --kill-after=1s ${NATIVE_TYPE_TIMEOUT_MS / 1000}s xdotool type --delay 75 --file \"$text_path\"`,
  ].join("\n");

  let created = false;
  let uploadCompleted = false;
  let phase: CuaTypeInputPhase = "preparation";
  let failure: CuaTypeInputPhase | undefined;
  let cleanup: "not-created" | "confirmed" | "unconfirmed" = "not-created";
  let finishTyping: ((acknowledged: boolean) => void) | undefined;
  try {
    signal?.throwIfAborted();
    cleanup = "unconfirmed";
    const prepared = await commands.run(preparation, { requestTimeoutMs: REQUEST_TIMEOUT_MS, timeoutMs: REQUEST_TIMEOUT_MS });
    if (prepared.exitCode !== 0) throw new Error("preparation not confirmed");
    created = true;
    cleanup = "unconfirmed";
    signal?.throwIfAborted();
    phase = "transfer";
    await files.write(file, text, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    uploadCompleted = true;
    signal?.throwIfAborted();
    phase = "input-uncertain";
    // No await between the final admission check and this sole keyboard dispatch.
    finishTyping = beginDesktopTyping(desktop, signal);
    const result = await commands.run(inputCommand, {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMs: NATIVE_TYPE_TIMEOUT_MS + 5_000,
    });
    // xdotool can report a skipped/unmappable character yet return zero. Any
    // diagnostic is uncertain input; never expose its possibly typed content.
    if (result.exitCode !== 0 || result.stdout?.trim() || result.stderr?.trim()) {
      throw new Error("input completion not confirmed");
    }
    signal?.throwIfAborted();
  } catch {
    failure = phase;
  } finally {
    if (created) {
      try {
        // Cleanup has independent admission: it can only remove this owned temporary path.
        const result = await commands.run(cleanupCommand, { requestTimeoutMs: CLEANUP_TIMEOUT_MS, timeoutMs: CLEANUP_TIMEOUT_MS });
        // A rejected upload may still finish server-side after this removal. An
        // acknowledged upload (including one followed by abort) has no such late write.
        const uploadUncertain = failure === "transfer" && !uploadCompleted;
        cleanup = result.exitCode === 0 && !uploadUncertain ? "confirmed" : "unconfirmed";
      } catch {
        cleanup = "unconfirmed";
      }
    }
  }
  finishTyping?.(failure === undefined && cleanup === "confirmed");
  if (failure !== undefined) throw new CuaTypeInputError(failure, cleanup);
  if (cleanup !== "confirmed") throw new CuaTypeInputError("cleanup", cleanup);
}
