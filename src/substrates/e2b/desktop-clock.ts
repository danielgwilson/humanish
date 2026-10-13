// The clock in the hosted desktop's panel. The stock template's XFCE panel sits above every window,
// so a participant sees its clock in each screenshot, and it shows the desktop's zone, UTC, unless
// its clock plugin names another.

import { shellQuote } from "../shell.js";
import type { E2BDesktopSandbox } from "./sdk.js";
import { e2bShell } from "./shell.js";

/**
 * Set every clock in the desktop's XFCE panel to `timeZone`, a tz database name, by writing the
 * clock plugin's `timezone` property through xfconf-query. The property lives in the session's
 * settings daemon, reached over the session bus whose address xfce4-session holds, and the panel
 * redraws its clock when the property changes (live: 02:12 UTC became 11:12 for Asia/Tokyo with no
 * restart). A desktop without xfconf-query or without a clock plugin is left as it is. Throws with
 * xfconf-query's error output when a clock is found and cannot be set.
 */
export async function setPanelClockZone(
  desktop: E2BDesktopSandbox,
  timeZone: string,
  requestTimeoutMs: number,
): Promise<void> {
  const result = await e2bShell(desktop).run(
    [
      `zone=${shellQuote(timeZone)}`,
      "command -v xfconf-query >/dev/null 2>&1 || exit 0",
      'session_pid="$(pgrep -x xfce4-session | head -n 1)"',
      'if [ -n "$session_pid" ]; then',
      `  bus="$(tr '\\0' '\\n' < "/proc/$session_pid/environ" | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')"`,
      '  if [ -n "$bus" ]; then export DBUS_SESSION_BUS_ADDRESS="$bus"; fi',
      "fi",
      `for plugin in $(xfconf-query -c xfce4-panel -p /plugins -l -v | awk '$2 == "clock" { print $1 }'); do`,
      '  xfconf-query -c xfce4-panel -p "$plugin/timezone" -n -t string -s "$zone" || exit 1',
      "done",
    ].join("\n"),
    { requestTimeoutMs, timeoutMs: 15_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `xfconf-query exited ${result.exitCode}`);
}
