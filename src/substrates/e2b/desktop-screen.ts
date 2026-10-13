// The hosted desktop's X screen saver. The stock template's XFCE session has three writers of its
// timeout, each acting in the session's first seconds: xfce4-screensaver sets its idle delay
// (300 s), xfce4-power-manager sets its blank-on-ac time (600 s), and an autostart entry runs
// `xset s off`. The last write wins. A timeout left at 300 s turns the screen black after 5 minutes
// without input, so a participant waiting on a page sees a black screen. The desktop runs on Xvfb,
// which has no display power management extension, so the screen saver is the only thing that
// blanks it.

import type { E2BDesktopSandbox } from "./sdk.js";
import { e2bShell } from "./shell.js";

/**
 * Turn the desktop's X screen saver off with `xset s off`. Nothing here waits for the three
 * writers, so a call holds only when it comes after their last write: on 16 fresh desktops that
 * write came 1.6 to 2.5 s after a command sent as soon as the desktop was created, and none came
 * in the following 27 s. After that, xfce4-screensaver and xfce4-power-manager write the timeout
 * again only when the xfconf settings of either one change, which setting the panel clock does not
 * do. A desktop without xset is left as it is. Throws with xset's error output when xset fails.
 */
export async function turnOffScreenSaver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
): Promise<void> {
  const result = await e2bShell(desktop).run(
    [
      'export DISPLAY="${DISPLAY:-:0}"',
      "command -v xset >/dev/null 2>&1 || exit 0",
      "xset s off",
    ].join("\n"),
    { requestTimeoutMs, timeoutMs: 15_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `xset exited ${result.exitCode}`);
}
