// Opening the subject in a browser on a hosted E2B desktop, the live stream, and the terminal
// window a desktop-CLI study starts in.
import {
  CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
  chromiumEvidenceProfilePreferencesJson,
} from "../../evidence/browser-hygiene.js";
import { failureTail } from "../../evidence/redaction.js";
import { isHttpUrl } from "../../lab/parse-subject.js";
import type { LabDesktopBrowser } from "../../lab/types.js";
import { runDesktopCommandOrThrow } from "../command-failure.js";
import { runDetachedStep } from "../detached.js";
import { shellQuote } from "../shell.js";
import type { E2BDesktopSandbox } from "./desktop-launch.js";
import type { DesktopMediaEvidence } from "./desktop-media.js";
import { e2bShell } from "./shell.js";

// Settle after opening the browser, before the first screenshot — long enough for a cold
// browser + page load to paint (2s captured a blank desktop; the render empirically needs ~6-9s).
export const BROWSER_SETTLE_MS = 8_000;

export interface DesktopBrowserEvidence {
  requested: LabDesktopBrowser;
  resolved?: string;
  /** Synthetic media devices the browser was launched with (#509), and how permission is answered. */
  media?: DesktopMediaEvidence;
}

export type DesktopBrowserFamily = "chromium" | "firefox" | "unknown";

/** Runtime-only identity for the exact browser process started by this lane. */
export interface DesktopBrowserLaunchIdentity {
  processId: string;
  profileDir: string;
  targetUrl: string;
  cdpPort?: number;
}

/** Runtime-only launch result. `evidence` preserves the existing public persistence policy. */
export interface DesktopBrowserLaunchResult {
  family: DesktopBrowserFamily;
  identity?: DesktopBrowserLaunchIdentity;
  evidence?: DesktopBrowserEvidence;
}

export async function findVisibleBrowserWindowId(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  browserFamily: DesktopBrowserFamily,
  launchIdentity: DesktopBrowserLaunchIdentity | undefined,
): Promise<string | undefined> {
  if (browserFamily === "unknown") return undefined;
  // The candidate loop keeps the LAST identity match: with a launch identity the match is
  // unique anyway, and without one every family candidate matches, so the newest visible
  // window of the launched family wins (the window this lane just opened).
  const finder =
    browserFamily === "firefox"
      ? [
          "find_firefox_window() {",
          "  timeout 2s xdotool search --onlyvisible --class 'firefox|Firefox' 2>/dev/null || true",
          "}",
          "window_id=",
          "for _ in $(seq 1 10); do",
          "  for candidate in $(find_firefox_window); do",
          '    window_pid="$(xdotool getwindowpid "$candidate" 2>/dev/null || true)"',
          '    if matches_launch_identity "$window_pid"; then window_id="$candidate"; fi',
          "  done",
          '  if [ -n "$window_id" ]; then break; fi',
          "  sleep 0.5",
          "done",
        ]
      : [
          "find_chrome_window() {",
          "  timeout 2s xdotool search --onlyvisible --class 'google-chrome|Google-chrome|chromium|Chromium|chrome|Chrome' 2>/dev/null || true",
          "}",
          "window_id=",
          "for _ in $(seq 1 10); do",
          "  for candidate in $(find_chrome_window); do",
          '    window_pid="$(xdotool getwindowpid "$candidate" 2>/dev/null || true)"',
          '    if matches_launch_identity "$window_pid"; then window_id="$candidate"; fi',
          "  done",
          '  if [ -n "$window_id" ]; then break; fi',
          "  sleep 0.5",
          "done",
        ];
  const result = await desktop.commands.run(
    [
      "set -euo pipefail",
      'export DISPLAY="${DISPLAY:-:0}"',
      `launch_pid=${shellQuote(launchIdentity?.processId ?? "")}`,
      `profile_dir=${shellQuote(launchIdentity?.profileDir ?? "")}`,
      "matches_launch_identity() {",
      '  if [ -z "$launch_pid" ] && [ -z "$profile_dir" ]; then return 0; fi',
      '  local current="${1:-}"',
      '  while [[ "$current" =~ ^[0-9]+$ ]] && [ "$current" -gt 1 ]; do',
      "    cmdline=\"$(tr '\\0' ' ' < \"/proc/$current/cmdline\" 2>/dev/null || true)\"",
      '    if [ -n "$profile_dir" ] && [[ "$cmdline" == *"$profile_dir"* ]]; then return 0; fi',
      '    if [ "$current" = "$launch_pid" ]; then return 0; fi',
      '    current="$(ps -o ppid= -p "$current" 2>/dev/null | tr -d \' \' || true)"',
      "  done",
      "  return 1",
      "}",
      ...finder,
      'if [ -n "$window_id" ]; then printf \'WINDOW_ID=%s\\n\' "$window_id"; fi',
    ].join("\n"),
    {
      requestTimeoutMs,
      timeoutMs: 15_000,
    },
  );
  return (result.stdout ?? "").match(/^WINDOW_ID=(\S+)$/m)?.[1];
}

/**
 * Build the xdotool command that makes a browser window fill the desktop.
 * Exported (pure) for contract tests. A window manager can ignore Chrome's
 * --window-size, so xdotool is the robust path: move the window to the origin,
 * then size it to the exact desktop resolution so Observer screenshots carry no
 * dead margin around the browser.
 */
export function buildFillDesktopWindowCommand(
  windowId: string,
  width: number,
  height: number,
): string {
  return [
    "set -euo pipefail",
    `win=${shellQuote(windowId)}`,
    `xdotool windowactivate "$win" >/dev/null 2>&1 || true`,
    `xdotool windowmove "$win" 0 0 >/dev/null 2>&1 || true`,
    `xdotool windowsize "$win" ${width} ${height} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/**
 * Best-effort initial fill. A contained smaller window remains usable; the capture
 * below checks for clipping and refuses an uncorrectable window before the actor runs.
 */
export async function fillDesktopBrowserWindow(
  desktop: E2BDesktopSandbox,
  windowId: string,
  resolution: readonly [number, number],
  requestTimeoutMs: number,
): Promise<void> {
  const [width, height] = resolution;
  await desktop.commands
    .run(buildFillDesktopWindowCommand(windowId, width, height), {
      requestTimeoutMs,
      timeoutMs: 10_000,
    })
    .catch(() => undefined);
}

export async function openDesktopBrowserTarget(
  desktop: E2BDesktopSandbox,
  targetUrl: string,
  requestTimeoutMs: number,
  browserPreference: LabDesktopBrowser | undefined,
  /** Launch-time flags that make mobile fidelity (#221) hold across every tab: the user agent and
   *  touch events are browser-wide here, where the CDP holder covers only the launch page. */
  extraChromiumFlags: readonly string[] = [],
  environment?: Readonly<Record<string, string>>,
): Promise<DesktopBrowserLaunchResult> {
  const requestedBrowser = browserPreference ?? "default";
  if (isHttpUrl(targetUrl)) {
    const chromiumFlags = [...CHROMIUM_EVIDENCE_HYGIENE_FLAGS, ...extraChromiumFlags]
      .map(shellQuote)
      .join(" ");
    const browserLaunchCommand = [
      "set -euo pipefail",
      `target_url=${shellQuote(targetUrl)}`,
      `browser_preference=${shellQuote(requestedBrowser)}`,
      "chrome_profile_dir=",
      `chrome_preferences_json=${shellQuote(chromiumEvidenceProfilePreferencesJson())}`,
      "prepare_chrome_profile() {",
      '  chrome_profile_dir="$(mktemp -d /tmp/humanish-chrome-profile.XXXXXX)"',
      '  mkdir -p "$chrome_profile_dir/Default"',
      '  printf \'%s\\n\' "$chrome_preferences_json" > "$chrome_profile_dir/Default/Preferences"',
      "}",
      "launch_browser() {",
      '  local label="$1"',
      '  local binary="$2"',
      "  shift 2",
      '  if command -v "$binary" >/dev/null 2>&1; then',
      '    nohup "$binary" "$@" "$target_url" >/tmp/humanish-browser-open.log 2>&1 &',
      "    local launch_pid=$!",
      "    printf 'HUMANISH_BROWSER_RESOLVED=%s\\n' \"$label\"",
      "    printf 'HUMANISH_BROWSER_PID=%s\\n' \"$launch_pid\"",
      "    printf 'HUMANISH_BROWSER_PROFILE_DIR=%s\\n' \"$chrome_profile_dir\"",
      '    if [[ "$label" =~ ^(google-chrome|google-chrome-stable|chromium|chromium-browser)$ ]]; then',
      "      for _ in $(seq 1 30); do",
      '        if [ -s "$chrome_profile_dir/DevToolsActivePort" ]; then',
      "          head -n 1 \"$chrome_profile_dir/DevToolsActivePort\" | sed 's/^/HUMANISH_BROWSER_CDP_PORT=/'",
      "          break",
      "        fi",
      "        sleep 0.1",
      "      done",
      "    fi",
      "    return 0",
      "  fi",
      "  return 1",
      "}",
      // Fixed CDP port (not :0/random): each seat has its OWN desktop sandbox, so a known port
      // cannot conflict, and it makes the observer's port resolution deterministic. With :0 the
      // real port lives only in DevToolsActivePort; when the launch-time capture misses on a cold
      // start the observer falls back to 9222 and — being wrong — every CDP read fails for the
      // whole run (the lobby-code handoff then never sees the host's /lobby URL). 9222 is already
      // the fallback, so making it the actual port aligns launch, capture, and fallback.
      `chrome_debug_flags=(--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 ${chromiumFlags})`,
      "open_target() {",
      '  case "$browser_preference" in',
      "    chrome)",
      "      prepare_chrome_profile",
      '      launch_browser google-chrome google-chrome --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser google-chrome-stable google-chrome-stable --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      "      echo 'requested browser chrome was not found' >&2",
      "      return 127",
      "      ;;",
      "    chromium)",
      "      prepare_chrome_profile",
      '      launch_browser chromium chromium --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser chromium-browser chromium-browser --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      "      echo 'requested browser chromium was not found' >&2",
      "      return 127",
      "      ;;",
      "    firefox)",
      "      prepare_chrome_profile",
      '      launch_browser firefox firefox --new-instance --no-remote --new-window --profile "$chrome_profile_dir" && return 0',
      "      echo 'requested browser firefox was not found' >&2",
      "      return 127",
      "      ;;",
      "    default)",
      "      prepare_chrome_profile",
      '      launch_browser google-chrome google-chrome --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser google-chrome-stable google-chrome-stable --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser chromium chromium --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser chromium-browser chromium-browser --new-window "--user-data-dir=$chrome_profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser firefox firefox --new-instance --no-remote --new-window --profile "$chrome_profile_dir" && return 0',
      "      launch_browser xdg-open xdg-open && return 0",
      "      echo 'no browser opener found' >&2",
      "      return 127",
      "      ;;",
      "  esac",
      "}",
      "open_target",
    ].join("\n");
    const result = await runDesktopCommandOrThrow(
      () =>
        desktop.commands.run(browserLaunchCommand, {
          requestTimeoutMs,
          timeoutMs: 15_000,
          ...(environment === undefined ? {} : { envs: { ...environment } }),
        }),
      ({ exitCode, stderrTail }) =>
        new Error(
          `browser launch failed${exitCode === undefined ? "" : ` with exit ${exitCode}`}: ${stderrTail}`,
        ),
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new Error(
        `browser launch failed with exit ${result.exitCode}: ${failureTail(result.stderr ?? result.stdout ?? "")}`,
      );
    }
    const resolved = (result.stdout ?? "").match(/^HUMANISH_BROWSER_RESOLVED=(\S+)$/m)?.[1];
    const processId = (result.stdout ?? "").match(/^HUMANISH_BROWSER_PID=(\d+)$/m)?.[1];
    const profileDir = (result.stdout ?? "").match(/^HUMANISH_BROWSER_PROFILE_DIR=(\S+)$/m)?.[1];
    const cdpPortRaw = (result.stdout ?? "").match(/^HUMANISH_BROWSER_CDP_PORT=(\d+)$/m)?.[1];
    const cdpPort = cdpPortRaw === undefined ? undefined : Number(cdpPortRaw);
    return {
      family: desktopBrowserFamily(resolved ?? requestedBrowser),
      ...(processId === undefined || profileDir === undefined
        ? {}
        : {
            identity: {
              processId,
              profileDir,
              targetUrl,
              ...(cdpPort === undefined ? {} : { cdpPort }),
            },
          }),
      ...(browserPreference === undefined
        ? {}
        : {
            evidence: {
              requested: requestedBrowser,
              ...(resolved === undefined ? {} : { resolved }),
            },
          }),
    };
  }

  if (browserPreference === undefined || browserPreference === "default") {
    if (desktop.open) {
      await desktop.open(targetUrl);
    } else {
      await desktop.launch("google-chrome", targetUrl);
    }
    return {
      family: desktop.open ? "unknown" : "chromium",
      ...(browserPreference === undefined ? {} : { evidence: { requested: requestedBrowser } }),
    };
  }

  const launchTarget =
    requestedBrowser === "chrome"
      ? "google-chrome"
      : requestedBrowser === "chromium"
        ? "chromium"
        : requestedBrowser === "firefox"
          ? "firefox"
          : "google-chrome";
  await desktop.launch(launchTarget, targetUrl);
  return {
    family: desktopBrowserFamily(launchTarget),
    evidence: { requested: requestedBrowser, resolved: launchTarget },
  };
}

function desktopBrowserFamily(value: string | undefined): DesktopBrowserFamily {
  if (value === "firefox") return "firefox";
  if (
    value === "chrome" ||
    value === "chromium" ||
    value === "google-chrome" ||
    value === "google-chrome-stable" ||
    value === "chromium-browser"
  ) {
    return "chromium";
  }
  return "unknown";
}

/**
 * Open a terminal window on the desktop.
 *
 * The stock template is XFCE and ships xfce4-terminal (also aliased x-terminal-emulator), verified
 * live before this route was built. `x-terminal-emulator` is tried first so a template that swaps
 * the emulator still works; a desktop with neither is a template problem and fails closed rather
 * than handing a participant an empty screen and calling it a study.
 */
export async function openDesktopTerminal(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  workdir: string | undefined,
): Promise<void> {
  const dir = workdir ?? "/home/user";
  const result = await runDetachedStep(e2bShell(desktop), {
    name: "desktop-cli-terminal",
    command: [
      "for candidate in x-terminal-emulator xfce4-terminal gnome-terminal konsole xterm; do",
      '  if command -v "$candidate" >/dev/null 2>&1; then',
      // LANG is set on the terminal we open, not globally: the stock image declares no locale, and
      // a study that measures our own mojibake against an unconfigured template would be measuring
      // the template. The PRODUCT-side fix (an ASCII fallback when the locale is not UTF-8) is in
      // src/routes/terminal/encoding.ts, and it is the one that matters for real users.
      `    (cd ${shellQuote(dir)} 2>/dev/null || cd /home/user; DISPLAY=:0 LANG=C.UTF-8 LC_ALL=C.UTF-8 HUMANISH_STUDY_PARTICIPANT=1 nohup "$candidate" >/dev/null 2>&1 &)`,
      "    sleep 3",
      '    echo "humanish: opened $candidate"',
      "    exit 0",
      "  fi",
      "done",
      "echo 'humanish: no terminal emulator on this desktop template' >&2",
      "exit 1",
    ].join("\n"),
    cwd: "/home/user",
    timeoutMs: 60_000,
    requestTimeoutMs,
  });
  if (!result.ok) {
    throw new Error("desktop-cli lane could not open a terminal on this desktop template");
  }
}

export async function startDesktopStream(
  desktop: E2BDesktopSandbox,
  browserWindowId: string | undefined,
): Promise<void> {
  if (!browserWindowId) {
    await desktop.stream.start({ requireAuth: true });
    return;
  }

  try {
    await desktop.stream.start({ requireAuth: true, windowId: browserWindowId });
  } catch {
    await desktop.stream.start({ requireAuth: true });
  }
}
