import { BROWSER_CONTROL_LIMITS } from "./browser-control-protocol.js";
import { CuaExecutorError, isCuaExecutorError } from "./cua-executor-error.js";
import type { GuestDesktopTools } from "./guest-desktop-executor.js";
import type { GuestDesktopNativeTools } from "./guest-desktop-native.js";

interface BrowserTextPort extends Pick<GuestDesktopTools, "prepareText"> {
  assertReady(signal: AbortSignal): Promise<void>;
}

/** Owner-only composition for a single headed Chromium page. Never an actor API. */
export function createGuestBrowserTools(native: GuestDesktopNativeTools, content: BrowserTextPort): GuestDesktopTools {
  let addressBarArmed = false;
  let generation = 0;
  return {
    capture: signal => native.capture(signal),
    async input(args, signal) {
      addressBarArmed = false;
      const inputGeneration = ++generation;
      await native.input(args, signal);
      if (signal.aborted || inputGeneration !== generation) throw new CuaExecutorError("session_revoked", "outcome_uncertain");
      // Positive navigation intent, not an inference from document.hasFocus().
      addressBarArmed = args.length === 3 && args[0] === "key" && args[1] === "--clearmodifiers" && args[2] === "ctrl+l";
    },
    async prepareText(text, signal) {
      const navigation = addressBarArmed;
      addressBarArmed = false;
      if (!navigation) return content.prepareText(text, signal);
      // Other browser chrome, IME composition, and Unicode omnibox text need
      // separate qualification. Do not silently switch routes or transliterate.
      if (!/^[\x20-\x7e]+$/.test(text) || Buffer.byteLength(text) > BROWSER_CONTROL_LIMITS.textBytes) {
        throw new CuaExecutorError("action_rejected", "not_dispatched");
      }
      const preparedGeneration = generation;
      let used = false;
      function check(): void {
        if (signal.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
        if (used || preparedGeneration !== generation) throw new CuaExecutorError("action_rejected", "not_dispatched");
      }
      check();
      await content.assertReady(signal);
      check();
      return {
        async paste() {
          check();
          await content.assertReady(signal);
          check();
          used = true;
          // Re-establish the explicitly requested destination immediately before
          // native typing; the previous page may have changed its own focus.
          try {
            await native.input(["key", "--clearmodifiers", "ctrl+l"], signal);
            if (signal.aborted) throw new CuaExecutorError("session_revoked", "outcome_uncertain");
            await content.assertReady(signal);
            if (signal.aborted || preparedGeneration !== generation) throw new CuaExecutorError("session_revoked", "outcome_uncertain");
            await native.typeAscii(text, signal);
          } catch (error) {
            // Ctrl+L itself is input. No content fallback after that dispatch.
            throw new CuaExecutorError(isCuaExecutorError(error) ? error.code : "execution_failed", "outcome_uncertain");
          }
        },
        async close() { used = true; }
      };
    }
  };
}
