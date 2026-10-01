// Opening the subject in a browser on a hosted E2B desktop, the live stream, and the terminal
// window a desktop-CLI study starts in.
import {
  CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
  chromiumEvidenceProfilePreferencesJson,
} from "../../evidence/browser-hygiene.js";
import { failureTail } from "../../evidence/redaction.js";
import { isHttpUrl } from "../../lab/parse/subject.js";
import type { LabDesktopBrowser } from "../../lab/types.js";
import { runDetachedStep } from "../detached.js";
import { shellQuote } from "../shell.js";
import type { E2BDesktopSandbox } from "./sdk.js";
import type { DesktopMediaEvidence } from "./desktop-media.js";
import { e2bShell } from "./shell.js";

// Settle after opening the browser or the terminal, before the first screenshot: long enough for
// a cold browser and page load to paint (2 s captured a blank desktop; the render needs 6-9 s).
export const DESKTOP_SETTLE_MS = 8_000;

/** The DevTools port every Chromium lane launches with; see `chrome_debug_flags` below. */
export const CHROME_DEVTOOLS_PORT = 9222;

/**
 * How long the launch command waits for Chrome's DevTools port to answer. Six live launches on the
 * stock desktop answered in 4.8-7.7 s; two device-emulated lanes failed when it had not answered
 * about 11 s after launch, and a CI leg once waited 20 s for the port marker.
 */
const CHROME_DEVTOOLS_READY_MS = 30_000;

/**
 * Waits for Chrome's DevTools HTTP endpoint, run on the sandbox's python3 like the CDP probe.
 * argv: launched pid, port, deadline ms, browser log path. Prints one marker block and exits 0:
 * HUMANISH_BROWSER_CDP_READY_MS when `/json/version` answers, or HUMANISH_BROWSER_CDP_NOT_READY
 * (`exited` when the launched process is gone or a zombie, `timeout` at the deadline) with the
 * waited ms and the browser log's last line. urllib is opened without proxy handlers, like the
 * probe, so a sandbox-wide http_proxy cannot redirect the loopback read.
 */
const CHROME_DEVTOOLS_READY_PY = String.raw`
import os, sys, time, urllib.request

pid, port, deadline_ms, log_path = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
started = time.monotonic()

def waited():
    return int((time.monotonic() - started) * 1000)

def alive():
    try:
        with open("/proc/%d/stat" % pid, "r") as handle:
            return handle.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False
    except Exception:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

def log_tail():
    try:
        with open(log_path, "rb") as handle:
            handle.seek(0, 2)
            handle.seek(max(0, handle.tell() - 2000))
            lines = [line.strip() for line in handle.read().decode("utf-8", "replace").splitlines()]
        lines = [line for line in lines if line]
        return "".join(ch if ch.isprintable() else " " for ch in (lines[-1] if lines else ""))[-300:]
    except Exception:
        return ""

def not_ready(state):
    print("HUMANISH_BROWSER_CDP_NOT_READY=%s" % state)
    print("HUMANISH_BROWSER_CDP_WAITED_MS=%d" % waited())
    print("HUMANISH_BROWSER_LOG_TAIL=%s" % log_tail())

while True:
    try:
        with opener.open("http://127.0.0.1:%d/json/version" % port, timeout=1) as response:
            response.read()
        print("HUMANISH_BROWSER_CDP_READY_MS=%d" % waited())
        break
    except Exception:
        pass
    if not alive():
        not_ready("exited")
        break
    if waited() >= deadline_ms:
        not_ready("timeout")
        break
    time.sleep(0.25)
`;

/**
 * The shell step that waits for DevTools after a Chromium launch. `pid` is a shell word (the
 * launch script passes "$launch_pid"). Without python3 it prints nothing, which reads as no
 * readiness evidence: the lane keeps its previous behavior.
 */
export function chromeDevToolsReadinessCommand(args: {
  pid: string;
  port?: number;
  deadlineMs?: number;
  logPath: string;
}): string {
  return [
    "if command -v python3 >/dev/null 2>&1; then",
    `  python3 -c ${shellQuote(CHROME_DEVTOOLS_READY_PY)} ${args.pid} ${args.port ?? CHROME_DEVTOOLS_PORT} ${args.deadlineMs ?? CHROME_DEVTOOLS_READY_MS} ${shellQuote(args.logPath)} || true`,
    "fi",
  ].join("\n");
}

/** What the launch command saw of Chrome's DevTools port; absent when it had nothing to wait for. */
export type ChromeDevToolsReadiness =
  | { state: "ready"; waitedMs: number }
  | { state: "exited" | "timeout"; waitedMs: number; logTail: string };

/** Reads the readiness markers from a launch command's stdout. */
export function parseChromeDevToolsReadiness(stdout: string): ChromeDevToolsReadiness | undefined {
  const ready = stdout.match(/^HUMANISH_BROWSER_CDP_READY_MS=(\d+)$/m)?.[1];
  if (ready !== undefined) return { state: "ready", waitedMs: Number(ready) };
  const state = stdout.match(/^HUMANISH_BROWSER_CDP_NOT_READY=(exited|timeout)$/m)?.[1];
  if (state !== "exited" && state !== "timeout") return undefined;
  return {
    state,
    waitedMs: Number(stdout.match(/^HUMANISH_BROWSER_CDP_WAITED_MS=(\d+)$/m)?.[1] ?? "0"),
    logTail: stdout.match(/^HUMANISH_BROWSER_LOG_TAIL=(.*)$/m)?.[1] ?? "",
  };
}

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

/**
 * Runtime-only launch result. `evidence` is what the bundle records: the requested browser and the
 * one that launched, and only when the lab declared a browser.
 */
export interface DesktopBrowserLaunchResult {
  family: DesktopBrowserFamily;
  identity?: DesktopBrowserLaunchIdentity;
  evidence?: DesktopBrowserEvidence;
  /** Runtime-only: how Chrome's DevTools port answered after launch (Chromium launches only). */
  devTools?: ChromeDevToolsReadiness;
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
  const result = await e2bShell(desktop).run(
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
  return result.stdout.match(/^WINDOW_ID=(\S+)$/m)?.[1];
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
  await e2bShell(desktop)
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
      "profile_dir=",
      `chrome_preferences_json=${shellQuote(chromiumEvidenceProfilePreferencesJson())}`,
      "prepare_profile() {",
      '  profile_dir="$(mktemp -d /tmp/humanish-chrome-profile.XXXXXX)"',
      '  mkdir -p "$profile_dir/Default"',
      '  printf \'%s\\n\' "$chrome_preferences_json" > "$profile_dir/Default/Preferences"',
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
      "    printf 'HUMANISH_BROWSER_PROFILE_DIR=%s\\n' \"$profile_dir\"",
      '    if [[ "$label" =~ ^(google-chrome|google-chrome-stable|chromium|chromium-browser)$ ]]; then',
      // Wait for DevTools to answer before anything reads it: the emulation holder, the geometry
      // probe and the state observer each make a single /json read.
      // Not re-indented: the python source inside the quoted argument is whitespace-sensitive.
      chromeDevToolsReadinessCommand({
        pid: '"$launch_pid"',
        logPath: "/tmp/humanish-browser-open.log",
      }),
      '      if [ -s "$profile_dir/DevToolsActivePort" ]; then',
      "        head -n 1 \"$profile_dir/DevToolsActivePort\" | sed 's/^/HUMANISH_BROWSER_CDP_PORT=/'",
      "      fi",
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
      `chrome_debug_flags=(--remote-debugging-address=127.0.0.1 --remote-debugging-port=${CHROME_DEVTOOLS_PORT} ${chromiumFlags})`,
      "open_target() {",
      '  case "$browser_preference" in',
      "    chrome)",
      "      prepare_profile",
      '      launch_browser google-chrome google-chrome --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser google-chrome-stable google-chrome-stable --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      "      echo 'requested browser chrome was not found' >&2",
      "      return 127",
      "      ;;",
      "    chromium)",
      "      prepare_profile",
      '      launch_browser chromium chromium --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser chromium-browser chromium-browser --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      "      echo 'requested browser chromium was not found' >&2",
      "      return 127",
      "      ;;",
      "    firefox)",
      "      prepare_profile",
      '      launch_browser firefox firefox --new-instance --no-remote --new-window --profile "$profile_dir" && return 0',
      "      echo 'requested browser firefox was not found' >&2",
      "      return 127",
      "      ;;",
      "    default)",
      "      prepare_profile",
      '      launch_browser google-chrome google-chrome --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser google-chrome-stable google-chrome-stable --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser chromium chromium --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser chromium-browser chromium-browser --new-window "--user-data-dir=$profile_dir" "${chrome_debug_flags[@]}" && return 0',
      '      launch_browser firefox firefox --new-instance --no-remote --new-window --profile "$profile_dir" && return 0',
      "      launch_browser xdg-open xdg-open && return 0",
      "      echo 'no browser opener found' >&2",
      "      return 127",
      "      ;;",
      "  esac",
      "}",
      "open_target",
    ].join("\n");
    const result = await e2bShell(desktop).run(browserLaunchCommand, {
      requestTimeoutMs,
      timeoutMs: CHROME_DEVTOOLS_READY_MS + 15_000,
      ...(environment === undefined ? {} : { env: environment }),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `browser launch failed with exit ${result.exitCode}: ${failureTail(result.stderr || result.stdout)}`,
      );
    }
    const resolved = result.stdout.match(/^HUMANISH_BROWSER_RESOLVED=(\S+)$/m)?.[1];
    const processId = result.stdout.match(/^HUMANISH_BROWSER_PID=(\d+)$/m)?.[1];
    const profileDir = result.stdout.match(/^HUMANISH_BROWSER_PROFILE_DIR=(\S+)$/m)?.[1];
    const cdpPortRaw = result.stdout.match(/^HUMANISH_BROWSER_CDP_PORT=(\d+)$/m)?.[1];
    const cdpPort = cdpPortRaw === undefined ? undefined : Number(cdpPortRaw);
    const devTools = parseChromeDevToolsReadiness(result.stdout);
    return {
      family: desktopBrowserFamily(resolved ?? requestedBrowser),
      ...(devTools === undefined ? {} : { devTools }),
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
 * The stock template is XFCE and ships xfce4-terminal (also aliased x-terminal-emulator).
 * `x-terminal-emulator` is tried first so a template that swaps
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
