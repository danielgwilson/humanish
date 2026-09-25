// Hosted desktop setup primitives. The lane adapter owns their lifecycle.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
  chromiumEvidenceProfilePreferencesJson
} from "./browser-evidence-hygiene.js";
import {
  chromeCdpProbeCommand,
  parseChromeCdpProbeOutput,
  type ChromeCdpPagePreference,
  type ChromeMobileEmulationRequest
} from "./chrome-cdp-probe.js";
import { runDesktopCommandOrThrow, toErrorMessage } from "./command-failure.js";
import {
  type DevicePreset
} from "./device-presets.js";
import {
  withOneRetryOnTransientE2BError,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import {
  probeUrl,
  readDetachedLog,
  runDetachedStep,
  startDetachedProcess,
  type DetachedStepOptions,
  type DetachedStepResult,
  type DetachedTimers
} from "./e2b-detached.js";
import {
  isHttpUrl,
  type LabDesktopBrowser,
  type LabDesktopMedia,
  type LabStateStepWhen,
  type LabSubjectServe,
  type LabSubjectState
} from "./lab-config.js";
import { digestText, redactText, redactedTail } from "./redaction.js";
import {
  type RunDesktopGeometry,
  type RunSubjectStateStepRecord
} from "./run.js";
import { corepackCommandFor, needsNodeRuntime, nodeBootstrapCommand } from "./subject-runtime.js";
import { TERMINAL_NODE_BOOTSTRAP_COMMAND } from "./terminal-node-bootstrap.js";

export const CUA_ACTOR_LAB_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "humanish"
} as const;

// Settle after opening the browser, before the first screenshot — long enough for a cold
// browser + page load to paint (2s captured a blank desktop; the render empirically needs ~6-9s).
export const BROWSER_SETTLE_MS = 8_000;

export interface DesktopBrowserEvidence {
  requested: LabDesktopBrowser;
  resolved?: string;
  /** Synthetic media devices the browser was launched with (#509), and how permission is answered. */
  media?: DesktopMediaEvidence;
}

export interface DesktopMediaEvidence {
  camera?: { source: "synthetic" | "file"; file: string; };
  microphone?: { source: "speech" };
  permission: "prompt" | "granted";
  flags: string[];
}

/** Where a lane's synthetic camera feed lives inside the sandbox: a tmpfs the sandbox user can
 *  write, and a path that contains neither /tmp/ nor /home/, which the public-safety scan reads
 *  as an operator's local path (this one is the harness's own and belongs in the bundle). */
export const SANDBOX_MEDIA_DIR = "/dev/shm/humanish-media";

export const SANDBOX_CAMERA_PATH = `${SANDBOX_MEDIA_DIR}/camera.y4m`;

/** The synthetic feed: ffmpeg's test pattern, 640x480 at 10 fps, six seconds (about 28 MB of
 *  raw Y4M on the tmpfs), looped by Chrome's fake capture device. */
export const SYNTHETIC_CAMERA_COMMAND =
  `mkdir -p ${SANDBOX_MEDIA_DIR} && ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x480:rate=10 -t 6 -pix_fmt yuv420p ${SANDBOX_CAMERA_PATH}`;

/**
 * Put the declared camera feed in the sandbox and return the Chromium flags that present it as a
 * capture device (#509). Fails CLOSED: a feed that cannot be produced (no ffmpeg on the image, an
 * unreadable host file) is named before the browser launches, because a participant told it has
 * a camera and finds none reports the instrument's gap as the product's.
 */
export async function prepareDesktopMedia(
  desktop: E2BDesktopSandbox,
  media: LabDesktopMedia,
  permission: "prompt" | "granted",
  cwd: string,
  requestTimeoutMs: number,
  readHostFile: (absolutePath: string) => Promise<Buffer> = (absolutePath) => readFile(absolutePath)
): Promise<DesktopMediaEvidence> {
  if (media.microphone !== undefined) {
    if (media.microphone.source !== "speech") throw new Error("Microphone source-file injection is unsupported; use source: speech.");
    if (media.camera !== undefined) throw new Error("Hosted synthetic cameras cannot be combined with speech.");
    // The lane starts and admits the speech worker before launching the browser.
    return { microphone: { source: "speech" }, permission, flags: permission === "granted" ? ["--use-fake-ui-for-media-stream"] : [] };
  }
  const flags: string[] = [];
  let camera: DesktopMediaEvidence["camera"];
  if (media.camera !== undefined) {
    if (media.camera.source === "synthetic") {
      const made = await desktop.commands.run(SYNTHETIC_CAMERA_COMMAND, { requestTimeoutMs, timeoutMs: 60_000 });
      if (made.exitCode !== undefined && made.exitCode !== 0) {
        throw new Error(
          `the synthetic camera feed could not be generated on this desktop image (ffmpeg exited ${made.exitCode}: ${tailOf(made.stderr ?? made.stdout ?? "")}); give execution.desktop.media.camera.source a .y4m file instead`
        );
      }
      camera = { source: "synthetic", file: SANDBOX_CAMERA_PATH };
    } else {
      const absolutePath = path.resolve(cwd, media.camera.source);
      let bytes: Buffer;
      try {
        bytes = await readHostFile(absolutePath);
      } catch (error) {
        throw new Error(`execution.desktop.media.camera.source could not be read (${toErrorMessage(error)})`);
      }
      if (bytes.length > 64 * 1024 * 1024) {
        throw new Error(`execution.desktop.media.camera.source is ${bytes.length} bytes; the camera feed is capped at 64 MiB`);
      }
      await desktop.commands.run(`mkdir -p ${SANDBOX_MEDIA_DIR}`, { requestTimeoutMs, timeoutMs: 15_000 });
      const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await desktop.files.write(SANDBOX_CAMERA_PATH, payload, { requestTimeoutMs, useOctetStream: true });
      camera = { source: "file", file: SANDBOX_CAMERA_PATH };
    }
    flags.push("--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${SANDBOX_CAMERA_PATH}`);
  }
  if (permission === "granted") flags.push("--use-fake-ui-for-media-stream");
  return { ...(camera === undefined ? {} : { camera }), permission, flags };
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

export const SUBJECT_DIR = "/home/user/subject";

// Remote path for the once-per-run packed local-tree archive; removed by the extract step
// after it unpacks into SUBJECT_DIR.
const LOCAL_TREE_REMOTE_ARCHIVE_PATH = "/home/user/.humanish-source.tar.gz";

const CLONE_TIMEOUT_MS = 5 * 60_000;

const INSTALL_TIMEOUT_MS = 10 * 60_000;

const BUILD_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_READY_TIMEOUT_MS = 180_000;

// Per-step budget for subject.state seed steps; each step's declared (or default) budget is
// also summed into the default sandbox deadline so seeding never eats the session's room.
export const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

// How much of a failing step's log tail rides the (redacted) error message.
const ERROR_TAIL_CHARS = 2000;

/**
 * One phase-boundary event from the shared subject provisioning pipeline (clone or local-tree
 * route): started/completed pairs at each named boundary, never per poll tick (the detached
 * primitive in e2b-detached.ts already polls every 1.5-3s internally; only the boundary itself
 * is surfaced here). Message text is public-safe by construction: no URLs beyond the existing
 * publicAppUrl convention, no paths, no command text. Completed events carry `ok` and
 * `durationMs`; started events (and the fire-and-forget `subject.serve.started`) carry neither.
 */
export interface SubjectPhaseEvent {
  at: string;
  type: string;
  ok?: boolean;
  durationMs?: number;
  message: string;
}

/** Mid-run inbox-surface render cadence (ms). Coarse enough that the per-tick `cat` + file writes stay
 *  cheap; fine enough that a verification email is visible seconds after the app sends it. */
export const INBOX_SURFACE_CADENCE_MS = 2500;

/**
 * The DECLARED preset to record alongside the rendered screen, or undefined when the preset
 * rendered faithfully.
 *
 * `desktopGeometry.screen.verified` compares the FLOORED number with itself, so on its own a
 * floored run is indistinguishable from a faithful one: a reader sees requested 500 / verified 500
 * and concludes a 500-wide screen was asked for. Recording the declared preset is what makes
 * "the preset width did not render" legible in the bundle.
 */
export function declaredScreenForRender(
  preset: DevicePreset,
  presetName: string,
  rendered: readonly [number, number],
): { width: number; height: number; preset: string; } | undefined {
  if (preset.width === rendered[0] && preset.height === rendered[1]) return undefined;
  return { width: preset.width, height: preset.height, preset: presetName };
}

/** ISO timestamp from an injectable clock (tests freeze `now` for deterministic durationMs). */
function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Emit a phase-started event (no ok/durationMs: those belong to the matching completed event). */
/**
 * Run a provisioning step and, when it fails with an EXIT CODE, run it once more (#602). A cold
 * install of 0.74.0 lost its whole first live study to one transient TLS error inside the
 * sandbox's `npm install`; the parallel install twenty seconds later passed, as had the ten
 * before it. One retry clears that class. A TIMEOUT is not retried: its budget is already spent,
 * and a second wait would double it. The retry runs under its own step name so both logs stay.
 */
async function runProvisioningStepWithOneRetry(
  desktop: E2BDesktopSandbox,
  args: {
    name: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    requestTimeoutMs: number;
    timers: Partial<Pick<DetachedStepOptions, "now" | "sleep" | "pollIntervalMs">>;
    /** Phase name for the retry's own started/completed events (`cua-lab.subject.<phase>.*`). */
    retryPhase: string;
    retryMessage: string;
    onPhase: ((event: SubjectPhaseEvent) => void) | undefined;
    now: () => number;
  }
): Promise<DetachedStepResult & { attempts: 1 | 2; firstExitCode?: number; }> {
  const first = await runDetachedStep(desktop, {
    name: args.name,
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    ...args.timers
  });
  if (first.ok || first.timedOut) return { ...first, attempts: 1 };
  const retryStartedAt = args.now();
  emitPhaseStarted(
    args.onPhase,
    args.now,
    args.retryPhase,
    `${args.retryMessage} (first attempt exited ${first.exitCode ?? "null"}; retrying once)`
  );
  const second = await runDetachedStep(desktop, {
    name: `${args.name}-retry`,
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    ...args.timers
  });
  emitPhaseCompleted(
    args.onPhase,
    args.now,
    retryStartedAt,
    args.retryPhase,
    second.ok,
    second.ok ? `${args.retryMessage}: succeeded on the second attempt` : `${args.retryMessage}: failed twice`
  );
  return { ...second, attempts: 2, ...(first.exitCode === undefined ? {} : { firstExitCode: first.exitCode }) };
}

function emitPhaseStarted(
  onPhase: ((event: SubjectPhaseEvent) => void) | undefined,
  now: () => number,
  phase: string,
  message: string
): void {
  onPhase?.({ at: isoNow(now), type: `cua-lab.subject.${phase}.started`, message });
}

/** Emit the matching phase-completed event: always carries ok and durationMs (>= 0). */
function emitPhaseCompleted(
  onPhase: ((event: SubjectPhaseEvent) => void) | undefined,
  now: () => number,
  startedAt: number,
  phase: string,
  ok: boolean,
  message: string
): void {
  onPhase?.({
    at: isoNow(now),
    type: `cua-lab.subject.${phase}.completed`,
    ok,
    durationMs: Math.max(0, now() - startedAt),
    message
  });
}

/** Default phase-boundary sink (stderr): one line per event, prefixed with the lane id ONLY
 *  when laneCount > 1. Single-lane emission is unconditional: total single-lane silence for the
 *  whole clone/install/build/ready boot is the bug this event stream exists to close.
 *  Overridable via CuaActorLabHooks.onPhase so deterministic tests capture instead of writing to
 *  the real stderr. */
export function defaultSubjectPhaseSink(event: SubjectPhaseEvent, ctx: { laneId: string; laneCount: number; }): void {
  const durationSuffix = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
  const prefix = ctx.laneCount > 1 ? `humanish cua [${ctx.laneId}]` : "humanish cua";
  process.stderr.write(`${prefix}: ${event.message}${durationSuffix}\n`);
}

/**
 * Verify the desktop screen geometry IN-SANDBOX (the per-lane device claim is checked, never
 * assumed). A parseable mismatch fails closed. Unavailable/unparseable evidence is returned as
 * an explicit warning: the lane may still run, but its bundle records only the requested screen
 * and never upgrades that request into a verified measurement.
 */
export async function inspectDesktopScreenGeometry(args: {
  desktop: E2BDesktopSandbox;
  laneId: string;
  requestedScreen: readonly [number, number];
  requestTimeoutMs: number;
}
): Promise<{
  verified?: RunDesktopGeometry["screen"]["verified"];
  error?: string;
  warning?: string;
}> {
  let out = "";
  try {
    const result = await args.desktop.commands.run("xdpyinfo 2>/dev/null | grep -i dimensions || true", { requestTimeoutMs: args.requestTimeoutMs });
    out = (result.stdout ?? "").trim();
  } catch {
    return { warning: `Desktop screen geometry could not be measured for lane ${args.laneId}; requested geometry remains unverified.` };
  }
  const match = out.match(/(\d+)\s*x\s*(\d+)\s*pixels/i);
  if (!match) {
    return { warning: `Desktop screen geometry could not be parsed for lane ${args.laneId}; requested geometry remains unverified.` };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const [expectedWidth, expectedHeight] = args.requestedScreen;
  if (width === expectedWidth && height === expectedHeight) {
    return { verified: { width, height, source: "xdpyinfo" } };
  }
  return {
    verified: { width, height, source: "xdpyinfo" },
    error: `HUMANISH_CUA_LAB_DEVICE_GEOMETRY: lane ${args.laneId} requested a ${expectedWidth}x${expectedHeight} desktop but xdpyinfo reports ${width}x${height} in-sandbox; the per-lane device geometry is unverified (fail-closed).`
  };
}

async function findVisibleBrowserWindowId(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  browserFamily: DesktopBrowserFamily,
  launchIdentity: DesktopBrowserLaunchIdentity | undefined
): Promise<string | undefined> {
  if (browserFamily === "unknown") return undefined;
  // The candidate loop keeps the LAST identity match: with a launch identity the match is
  // unique anyway, and without one every family candidate matches, so the newest visible
  // window of the launched family wins (the window this lane just opened).
  const finder = browserFamily === "firefox"
    ? [
      "find_firefox_window() {",
      "  timeout 2s xdotool search --onlyvisible --class 'firefox|Firefox' 2>/dev/null || true",
      "}",
      "window_id=",
      "for _ in $(seq 1 10); do",
      "  for candidate in $(find_firefox_window); do",
      "    window_pid=\"$(xdotool getwindowpid \"$candidate\" 2>/dev/null || true)\"",
      "    if matches_launch_identity \"$window_pid\"; then window_id=\"$candidate\"; fi",
      "  done",
      "  if [ -n \"$window_id\" ]; then break; fi",
      "  sleep 0.5",
      "done"
    ]
    : [
      "find_chrome_window() {",
      "  timeout 2s xdotool search --onlyvisible --class 'google-chrome|Google-chrome|chromium|Chromium|chrome|Chrome' 2>/dev/null || true",
      "}",
      "window_id=",
      "for _ in $(seq 1 10); do",
      "  for candidate in $(find_chrome_window); do",
      "    window_pid=\"$(xdotool getwindowpid \"$candidate\" 2>/dev/null || true)\"",
      "    if matches_launch_identity \"$window_pid\"; then window_id=\"$candidate\"; fi",
      "  done",
      "  if [ -n \"$window_id\" ]; then break; fi",
      "  sleep 0.5",
      "done"
    ];
  const result = await desktop.commands.run([
    "set -euo pipefail",
    "export DISPLAY=\"${DISPLAY:-:0}\"",
    `launch_pid=${shellSingleQuote(launchIdentity?.processId ?? "")}`,
    `profile_dir=${shellSingleQuote(launchIdentity?.profileDir ?? "")}`,
    "matches_launch_identity() {",
    "  if [ -z \"$launch_pid\" ] && [ -z \"$profile_dir\" ]; then return 0; fi",
    "  local current=\"${1:-}\"",
    "  while [[ \"$current\" =~ ^[0-9]+$ ]] && [ \"$current\" -gt 1 ]; do",
    "    cmdline=\"$(tr '\\0' ' ' < \"/proc/$current/cmdline\" 2>/dev/null || true)\"",
    "    if [ -n \"$profile_dir\" ] && [[ \"$cmdline\" == *\"$profile_dir\"* ]]; then return 0; fi",
    "    if [ \"$current\" = \"$launch_pid\" ]; then return 0; fi",
    "    current=\"$(ps -o ppid= -p \"$current\" 2>/dev/null | tr -d ' ' || true)\"",
    "  done",
    "  return 1",
    "}",
    ...finder,
    "if [ -n \"$window_id\" ]; then printf 'WINDOW_ID=%s\\n' \"$window_id\"; fi"
  ].join("\n"), {
    requestTimeoutMs,
    timeoutMs: 15_000
  });
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
    `win=${shellSingleQuote(windowId)}`,
    `xdotool windowactivate "$win" >/dev/null 2>&1 || true`,
    `xdotool windowmove "$win" 0 0 >/dev/null 2>&1 || true`,
    `xdotool windowsize "$win" ${width} ${height} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/**
 * Best-effort initial fill. A contained smaller window remains usable; the capture
 * below checks for clipping and refuses an uncorrectable window before the actor runs.
 */
async function fillDesktopBrowserWindow(
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
  environment?: Readonly<Record<string, string>>
): Promise<DesktopBrowserLaunchResult> {
  const requestedBrowser = browserPreference ?? "default";
  if (isHttpUrl(targetUrl)) {
    const chromiumFlags = [...CHROMIUM_EVIDENCE_HYGIENE_FLAGS, ...extraChromiumFlags].map(shellSingleQuote).join(" ");
    const browserLaunchCommand = [
      "set -euo pipefail",
      `target_url=${shellSingleQuote(targetUrl)}`,
      `browser_preference=${shellSingleQuote(requestedBrowser)}`,
      "chrome_profile_dir=",
      `chrome_preferences_json=${shellSingleQuote(chromiumEvidenceProfilePreferencesJson())}`,
      "prepare_chrome_profile() {",
      "  chrome_profile_dir=\"$(mktemp -d /tmp/humanish-chrome-profile.XXXXXX)\"",
      "  mkdir -p \"$chrome_profile_dir/Default\"",
      "  printf '%s\\n' \"$chrome_preferences_json\" > \"$chrome_profile_dir/Default/Preferences\"",
      "}",
      "launch_browser() {",
      "  local label=\"$1\"",
      "  local binary=\"$2\"",
      "  shift 2",
      "  if command -v \"$binary\" >/dev/null 2>&1; then",
      "    nohup \"$binary\" \"$@\" \"$target_url\" >/tmp/humanish-browser-open.log 2>&1 &",
      "    local launch_pid=$!",
      "    printf 'HUMANISH_BROWSER_RESOLVED=%s\\n' \"$label\"",
      "    printf 'HUMANISH_BROWSER_PID=%s\\n' \"$launch_pid\"",
      "    printf 'HUMANISH_BROWSER_PROFILE_DIR=%s\\n' \"$chrome_profile_dir\"",
      "    if [[ \"$label\" =~ ^(google-chrome|google-chrome-stable|chromium|chromium-browser)$ ]]; then",
      "      for _ in $(seq 1 30); do",
      "        if [ -s \"$chrome_profile_dir/DevToolsActivePort\" ]; then",
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
      "  case \"$browser_preference\" in",
      "    chrome)",
      "      prepare_chrome_profile",
      "      launch_browser google-chrome google-chrome --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser google-chrome-stable google-chrome-stable --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      echo 'requested browser chrome was not found' >&2",
      "      return 127",
      "      ;;",
      "    chromium)",
      "      prepare_chrome_profile",
      "      launch_browser chromium chromium --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser chromium-browser chromium-browser --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      echo 'requested browser chromium was not found' >&2",
      "      return 127",
      "      ;;",
      "    firefox)",
      "      prepare_chrome_profile",
      "      launch_browser firefox firefox --new-instance --no-remote --new-window --profile \"$chrome_profile_dir\" && return 0",
      "      echo 'requested browser firefox was not found' >&2",
      "      return 127",
      "      ;;",
      "    default)",
      "      prepare_chrome_profile",
      "      launch_browser google-chrome google-chrome --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser google-chrome-stable google-chrome-stable --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser chromium chromium --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser chromium-browser chromium-browser --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser firefox firefox --new-instance --no-remote --new-window --profile \"$chrome_profile_dir\" && return 0",
      "      launch_browser xdg-open xdg-open && return 0",
      "      echo 'no browser opener found' >&2",
      "      return 127",
      "      ;;",
      "  esac",
      "}",
      "open_target"
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
      throw new Error(`browser launch failed with exit ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
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
        : { identity: { processId, profileDir, targetUrl, ...(cdpPort === undefined ? {} : { cdpPort }) } }),
      ...(browserPreference === undefined
        ? {}
        : { evidence: { requested: requestedBrowser, ...(resolved === undefined ? {} : { resolved }) } })
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
      ...(browserPreference === undefined ? {} : { evidence: { requested: requestedBrowser } })
    };
  }

  const launchTarget = requestedBrowser === "chrome" ? "google-chrome"
    : requestedBrowser === "chromium" ? "chromium"
      : requestedBrowser === "firefox" ? "firefox"
        : "google-chrome";
  await desktop.launch(launchTarget, targetUrl);
  return {
    family: desktopBrowserFamily(launchTarget),
    evidence: { requested: requestedBrowser, resolved: launchTarget }
  };
}

export function desktopBrowserFamily(value: string | undefined): DesktopBrowserFamily {
  if (value === "firefox") return "firefox";
  if (value === "chrome" || value === "chromium" || value === "google-chrome" || value === "google-chrome-stable" || value === "chromium-browser") {
    return "chromium";
  }
  return "unknown";
}

/**
 * Runtime-only CDP endpoint attribution for the exact chromium this lane launched. Port
 * resolution at OBSERVE time: the cached launch-time `cdpPort` wins; absent that, the observer
 * probe re-reads `profileDir`'s DevToolsActivePort marker (a slow cold start can publish it
 * AFTER the launch-time poll gave up); absent both it falls back to the legacy fixed 9222,
 * where a dead endpoint degrades into an honest warning that names the cause.
 */
export interface ChromeCdpEndpoint {
  cdpPort?: number;
  /** The launched profile dir; lets observers re-read DevToolsActivePort at observe time. */
  profileDir?: string;
  /** The URL this lane opened; attributes the CDP page when no target id is pinned yet. */
  targetUrl: string;
}

/**
 * The URL / title / page-text / scroll observer behind stopWhen and task criteria. One probe per
 * observation, run on the sandbox's python3 (see chrome-cdp-probe.ts for why not node: #514).
 *
 * "active": follow the participant to whatever tab they are driving now — never pin the state
 * observer to the launch tab (a verification link that opened in a NEW tab left a pinned observer
 * reading the old tab forever).
 *
 * `onUnavailable` fires ONCE, on the first probe that could not read the page, with the reason.
 * The observer still degrades to `{}` for the loop; the callback is how a lane says out loud that
 * url/text criteria are not being measured, instead of letting the funnel report 0/N (#514).
 */
export function makeChromeBrowserStateObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId?: string,
  onUnavailable?: (reason: string) => void,
  /**
   * Mobile emulation on later tabs (#623): the holder attaches to every page target Chrome opens
   * after the launch page, so a tab the participant opens later should lay out at the phone width
   * too. The first observation on each new target reads that page's OWN report; a target that
   * reports the requested width is recorded through `onCovered`, and one that does not (or cannot
   * be read) fires `onDrift` once, so a phone-labelled lane that spent part of its session at
   * desktop layout says so with the number the page gave.
   */
  drift?: {
    emulatedTargetId: string;
    expectedWidth: number;
    expectTouch?: boolean;
    onDrift: (reason: string) => void;
    onCovered?: (targetId: string, read: { innerWidth: number; devicePixelRatio: number; maxTouchPoints: number; }) => void;
  }
): () => Promise<{ url?: string; title?: string; text?: string; scrollY?: number; }> {
  let reported = false;
  let drifted = false;
  const checkedTargets = new Set<string>(drift === undefined ? [] : [drift.emulatedTargetId]);
  const unavailable = (reason: string): Record<string, never> => {
    if (!reported) {
      reported = true;
      onUnavailable?.(reason);
    }
    return {};
  };
  const checkLaterTarget = async (newTargetId: string): Promise<void> => {
    if (drift === undefined || checkedTargets.has(newTargetId)) return;
    checkedTargets.add(newTargetId);
    const read = await desktop.commands.run(
      chromeCdpProbeCommand({ ...endpoint, targetId: newTargetId, prefer: "pinned", mode: "fidelity" }),
      { requestTimeoutMs, timeoutMs: 5_000 }
    );
    const fidelity = read.exitCode !== undefined && read.exitCode !== 0 ? undefined : parseChromeCdpProbeOutput(read.stdout).fidelity;
    if (fidelity !== undefined && fidelity.innerWidth === drift.expectedWidth) {
      drift.onCovered?.(newTargetId, { innerWidth: fidelity.innerWidth, devicePixelRatio: fidelity.devicePixelRatio, maxTouchPoints: fidelity.maxTouchPoints });
      if (drift.expectTouch === true && fidelity.maxTouchPoints === 0 && !drifted) {
        // The viewport followed; touch did not (yet): the holder reloads a later tab once after its
        // first navigation commits, and this observation may have landed before that reload.
        drifted = true;
        drift.onDrift(`a later page target reports the ${fidelity.innerWidth} px viewport but navigator.maxTouchPoints 0 on its first observation; touch reaches a document only when it loads under the override`);
      }
      return;
    }
    if (drifted) return;
    drifted = true;
    drift.onDrift(
      fidelity === undefined
        ? "the participant drove a page target other than the emulated launch tab and that page's own read-back could not be taken; whether it laid out at the phone width is not known"
        : `the participant drove a page target other than the emulated launch tab and that page reports a ${fidelity.innerWidth} px viewport where ${drift.expectedWidth} px was requested (DPR ${fidelity.devicePixelRatio}); the mobile user agent and touch events are browser-wide, the viewport override was not re-applied to it`
    );
  };
  return async () => {
    const result = await desktop.commands.run(
      chromeCdpProbeCommand({ ...endpoint, ...(targetId === undefined ? {} : { targetId }), prefer: "active", mode: "state" }),
      { requestTimeoutMs, timeoutMs: 5_000 }
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return unavailable(`probe exited ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
    }
    const parsed = parseChromeCdpProbeOutput(result.stdout);
    if (parsed.unavailable !== undefined) return unavailable(parsed.unavailable);
    if (parsed.targetId !== undefined) await checkLaterTarget(parsed.targetId);
    return {
      ...(parsed.url === undefined ? {} : { url: parsed.url }),
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      ...(parsed.scrollY === undefined ? {} : { scrollY: parsed.scrollY })
    };
  };
}

/**
 * Read the running browser's actual outer-window bounds and CSS layout viewport through the
 * already-enabled local Chrome DevTools endpoint. The returned values come from `window.*` in
 * the target page; requested E2B resolution is deliberately not an input to this function.
 * Missing channels report their reason via `onUnavailable`, so the geometry warning can name
 * the cause (a dead CDP endpoint, no python3) instead of only the symptom. Returns `undefined`
 * only when neither channel could be measured.
 * Outer bounds and CSS dimensions are independent channels: a background page can report zero
 * outer dimensions while still reporting a CSS viewport. Final captures follow the active tab;
 * launch captures and emulation attribution keep the pinned target.
 */
export function makeChromeDesktopGeometryObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId?: string,
  onUnavailable?: (reason: string) => void,
  prefer: ChromeCdpPagePreference = "pinned"
): () => Promise<(Pick<RunDesktopGeometry, "browserWindow" | "viewport"> & { targetId?: string; }) | undefined> {
  return async () => {
    const result = await desktop.commands.run(
      chromeCdpProbeCommand({ ...endpoint, ...(targetId === undefined ? {} : { targetId }), prefer, mode: "geometry" }),
      { requestTimeoutMs, timeoutMs: 5_000 }
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      onUnavailable?.(`probe exited ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
      return undefined;
    }
    const parsed = parseChromeCdpProbeOutput(result.stdout);
    if (parsed.unavailable !== undefined) {
      onUnavailable?.(parsed.unavailable);
      return undefined;
    }
    const browserWindow = isMeasuredRect(parsed.browserWindow) ? { ...parsed.browserWindow, source: "cdp" as const } : undefined;
    const viewport = isMeasuredViewport(parsed.viewport) ? { ...parsed.viewport, source: "cdp" as const } : undefined;
    if (browserWindow === undefined && viewport === undefined) {
      onUnavailable?.("the page reported no usable window or viewport dimensions");
      return undefined;
    }
    if (browserWindow === undefined) onUnavailable?.("the page reported no usable outer-window dimensions");
    if (viewport === undefined) onUnavailable?.("the page reported no usable CSS viewport dimensions");
    return {
      ...(browserWindow === undefined ? {} : { browserWindow }),
      ...(viewport === undefined ? {} : { viewport }),
      ...(parsed.targetId === undefined ? {} : { targetId: parsed.targetId })
    };
  };
}

/** The user agent a mobile-emulated lane presents unless the lab sets its own. */
export const DEFAULT_MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * Apply mobile emulation (#221) to the lane's launch page and read back what the page reports.
 * Fails CLOSED: a request that cannot be applied throws, because a desktop run labelled mobile is
 * the over-trust this feature exists to prevent. A read-back that cannot be taken is a warning
 * (the emulation was applied; only the proof is missing).
 */
export async function applyMobileEmulation(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId: string | undefined,
  request: ChromeMobileEmulationRequest
): Promise<{ fidelity: NonNullable<RunDesktopGeometry["fidelity"]>; warnings: string[]; targetId?: string; holderName: string; }> {
  const command = (mode: "hold" | "fidelity") =>
    chromeCdpProbeCommand({ ...endpoint, ...(targetId === undefined ? {} : { targetId }), prefer: "pinned", mode, emulation: request });
  const read = async () => {
    const result = await desktop.commands.run(command("fidelity"), { requestTimeoutMs, timeoutMs: 15_000 });
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return { unavailable: `probe exited ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}` };
    }
    return parseChromeCdpProbeOutput(result.stdout);
  };
  // The UA / touch / DPR overrides are bound to the DevTools session that set them and lapse the
  // moment its socket closes (measured: only the viewport width survived a one-shot apply). So the
  // applier stays attached for the lane's whole life as a detached process; the sandbox teardown
  // ends it. Its first stdout line says what was applied.
  const holderName = `mobile-emulation-${Date.now().toString(36)}`;
  await startDetachedProcess(desktop, { name: holderName, command: command("hold"), requestTimeoutMs });
  let announced: ReturnType<typeof parseChromeCdpProbeOutput> | undefined;
  for (let attempt = 0; attempt < 30 && announced === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await readDetachedLog(desktop, holderName, requestTimeoutMs).catch(() => "");
    const line = log.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (line !== undefined) announced = parseChromeCdpProbeOutput(line);
  }
  if (announced === undefined) {
    throw new Error("mobile emulation could not be applied: the in-sandbox applier printed nothing within 15 s");
  }
  if (announced.unavailable !== undefined) {
    throw new Error(
      `mobile emulation could not be applied (${announced.unavailable}); applied before failing: ${(announced.applied ?? []).join(", ") || "nothing"}`
    );
  }
  const applied = announced;
  // Viewport/touch read-back proves context settings, not gesture equivalence. Two hosted
  // replicas and a native-X conversion-toggle control reproduced reset click counts (#676).
  const warnings: string[] = request.touch
    ? ["Mobile emulation uses desktop pointer-to-touch conversion, which can differ for repeated taps. Confirm gesture failures with direct or native touch input before attributing them to the app."]
    : [];
  // The reload inside the applier takes a moment; the read-back is retried until the page reports
  // the requested viewport and user agent, so a slow page does not read as "no proof".
  let readBack = await read();
  for (
    let attempt = 0;
    attempt < 20 && (readBack.fidelity === undefined || readBack.fidelity.innerWidth !== request.width || !readBack.fidelity.userAgent.includes(request.userAgent.slice(0, 24)));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    readBack = await read();
  }
  const fidelityRead = readBack;
  const requested = {
    width: request.width,
    height: request.height,
    deviceScaleFactor: request.deviceScaleFactor,
    touch: request.touch,
    userAgent: request.userAgent
  };
  const emulatedTargetId = applied.targetId ?? fidelityRead.targetId;
  if (fidelityRead.fidelity === undefined) {
    warnings.push(`Mobile emulation was applied but the page's own report could not be read (${fidelityRead.unavailable ?? "no fidelity read"}); desktopGeometry.fidelity carries the request without a resolved block.`);
    return { fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [] }, warnings, holderName, ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }) };
  }
  const resolved = { ...fidelityRead.fidelity, source: "cdp" as const };
  if (resolved.innerWidth !== request.width) {
    warnings.push(`Mobile emulation requested a ${request.width} px viewport; the page reports ${resolved.innerWidth} px.`);
  }
  if (resolved.devicePixelRatio !== request.deviceScaleFactor) {
    warnings.push(`Mobile emulation requested devicePixelRatio ${request.deviceScaleFactor}; the page reports ${resolved.devicePixelRatio}.`);
  }
  if (request.touch && resolved.maxTouchPoints === 0) {
    warnings.push("Mobile emulation requested touch; the page reports navigator.maxTouchPoints 0.");
  }
  if (!resolved.userAgent.includes("Mobile") && !resolved.userAgent.includes("Android") && !resolved.userAgent.includes("iPhone")) {
    warnings.push("Mobile emulation requested a mobile user agent; the page reports a desktop one.");
  }
  return { fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [], resolved }, warnings, holderName, ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }) };
}

function isMeasuredRect(value: unknown): value is { x: number; y: number; width: number; height: number; } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.x)
    && Number.isFinite(record.y)
    && isPositiveMeasurement(record.width)
    && isPositiveMeasurement(record.height);
}

function isMeasuredViewport(value: unknown): value is { width: number; height: number; deviceScaleFactor: number; } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isPositiveMeasurement(record.width)
    && isPositiveMeasurement(record.height)
    && isPositiveMeasurement(record.deviceScaleFactor);
}

function isPositiveMeasurement(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function measureBrowserWindowWithXwininfo(
  desktop: E2BDesktopSandbox,
  windowId: string,
  requestTimeoutMs: number
): Promise<RunDesktopGeometry["browserWindow"] | undefined> {
  const result = await desktop.commands.run([
    "set -euo pipefail",
    `win=${shellSingleQuote(windowId)}`,
    // Older xdotool builds translate parent-relative offsets twice. With window
    // decorations that falsely reports a visible client as clipped, triggering
    // fullscreen and hiding the participant's address bar. Read root-relative
    // client coordinates directly; never substitute emulated CDP outer bounds.
    "LC_ALL=C xwininfo -id \"$win\" -stats 2>/dev/null"
  ].join("\n"), { requestTimeoutMs, timeoutMs: 5_000 });
  if (result.exitCode !== undefined && result.exitCode !== 0) return undefined;
  return parseXwininfoGeometry(result.stdout ?? "");
}

/** Root-relative physical client bounds from xwininfo's C-locale stats. */
export function parseXwininfoGeometry(output: string): RunDesktopGeometry["browserWindow"] | undefined {
  const read = (label: string) => {
    const matches = [...output.matchAll(new RegExp(`^\\s*${label}:\\s*(-?\\d+)\\s*$`, "gm"))];
    if (matches.length !== 1) return undefined;
    const value = Number(matches[0]![1]);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const x = read("Absolute upper-left X");
  const y = read("Absolute upper-left Y");
  const width = read("Width");
  const height = read("Height");
  const mapStates = [...output.matchAll(/^\s*Map State:\s*(\S+)\s*$/gm)];
  if (mapStates.length !== 1 || mapStates[0]![1] !== "IsViewable") return undefined;
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height, source: "xwininfo" };
}

/** Physical X client bounds, never the page's emulated window.outerWidth/Height. */
function isBrowserWindowContained(
  bounds: NonNullable<RunDesktopGeometry["browserWindow"]>,
  [width, height]: readonly [number, number]
): boolean {
  return bounds.x >= 0 && bounds.y >= 0
    && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height;
}

/** Bounded repair. Resizing can clear a window-manager maximize state and move the
 * client origin as decorations return, so remeasure before a second adjustment. */
async function fitBrowserWindowWithinDesktop(
  desktop: E2BDesktopSandbox,
  windowId: string,
  resolution: readonly [number, number],
  requestTimeoutMs: number
): Promise<RunDesktopGeometry["browserWindow"] | undefined> {
  const run = (command: string) => desktop.commands.run([
    "set -euo pipefail",
    `win=${shellSingleQuote(windowId)}`,
    command
  ].join("\n"), { requestTimeoutMs, timeoutMs: 5_000 }).catch(() => undefined);
  await run('xdotool windowmove "$win" 0 0');
  await desktop.wait(250).catch(() => undefined);
  const moved = await measureBrowserWindowWithXwininfo(desktop, windowId, requestTimeoutMs).catch(() => undefined);
  if (moved === undefined) return moved;
  let resized = moved;
  // Resizing alone cannot fix an offscreen client origin. The window manager
  // can also center a minimum-width client at a negative x on a narrow screen.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isBrowserWindowContained(resized, resolution)) return resized;
    const width = resolution[0] - resized.x;
    const height = resolution[1] - resized.y;
    if (resized.x < 0 || resized.y < 0 || width <= 0 || height <= 0) break;
    await run(`xdotool windowsize "$win" ${width} ${height}`);
    await desktop.wait(250).catch(() => undefined);
    const measured = await measureBrowserWindowWithXwininfo(desktop, windowId, requestTimeoutMs).catch(() => undefined);
    if (measured === undefined) return measured;
    resized = measured;
  }
  if (resized === undefined || isBrowserWindowContained(resized, resolution)) return resized;
  // Chrome's minimum client width can equal the whole desktop. Window-manager
  // borders then make a decorated window impossible to contain, even after a
  // successful move/resize. Request fullscreen once and prove the physical result.
  // xprop/xdotool ship with the desktop template; wmctrl is not required.
  // Check state first so the fullscreen shortcut cannot toggle an existing state off.
  await run([
    'state=$(xprop -id "$win" _NET_WM_STATE)',
    'case "$state" in',
    '  *_NET_WM_STATE_FULLSCREEN*) ;;',
    '  *) xdotool windowactivate --sync "$win"; xdotool key --clearmodifiers F11 ;;',
    'esac'
  ].join("\n"));
  // The fullscreen animation may report its new origin before its final width.
  // Give the window manager a bounded settling window, keeping missing reads unverified.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await desktop.wait(250).catch(() => undefined);
    const measured = await measureBrowserWindowWithXwininfo(desktop, windowId, requestTimeoutMs).catch(() => undefined);
    if (measured === undefined || isBrowserWindowContained(measured, resolution)) return measured;
    resized = measured;
  }
  return resized;
}

/** Shared hosted-browser geometry capture used by per-lane and sequential shared-world routes. */
export async function captureDesktopBrowserGeometry(args: {
  desktop: E2BDesktopSandbox;
  browserFamily: DesktopBrowserFamily;
  launchIdentity?: DesktopBrowserLaunchIdentity;
  browserTargetId?: string;
  /** Launch captures stay pinned; final captures follow the participant's current page. */
  pagePreference?: ChromeCdpPagePreference;
  browserWindowId?: string;
  laneId: string;
  /** Runtime-only lane target URL (attributes the CDP page); never persisted by this capture. */
  targetUrl: string;
  requestedScreen: readonly [number, number];
  requestTimeoutMs: number;
  resize?: boolean;
}): Promise<{
  /** Known physical clipping (or unverified repair of it); startup must stop before actions. */
  unusable?: string;
  browserWindowId?: string;
  browserTargetId?: string;
  browserWindow?: RunDesktopGeometry["browserWindow"];
  viewport?: RunDesktopGeometry["viewport"];
  warnings: string[];
}> {
  const warnings: string[] = [];
  let browserWindowId = args.browserWindowId;
  if (browserWindowId === undefined && args.browserFamily !== "unknown") {
    browserWindowId = await findVisibleBrowserWindowId(
      args.desktop,
      args.requestTimeoutMs,
      args.browserFamily,
      args.launchIdentity
    ).catch((error: unknown) => {
      warnings.push(`Browser window lookup failed for lane ${args.laneId}: ${redactText(toErrorMessage(error))}`);
      return undefined;
    });
  }

  let physicalWindow: RunDesktopGeometry["browserWindow"] | undefined;
  if (browserWindowId !== undefined) {
    if (args.resize !== false) {
      await fillDesktopBrowserWindow(args.desktop, browserWindowId, args.requestedScreen, args.requestTimeoutMs);
      // Let the window manager apply the resize before querying both X and page layout geometry.
      await args.desktop.wait(250).catch(() => undefined);
    }
    physicalWindow = await measureBrowserWindowWithXwininfo(args.desktop, browserWindowId, args.requestTimeoutMs)
      .catch(() => undefined);
  } else {
    warnings.push(`Browser window bounds could not be measured for lane ${args.laneId}; the live stream will use the full desktop.`);
  }

  let unusable: string | undefined;
  if (physicalWindow !== undefined && !isBrowserWindowContained(physicalWindow, args.requestedScreen)) {
    const before = physicalWindow;
    if (args.resize !== false && browserWindowId !== undefined) {
      physicalWindow = await fitBrowserWindowWithinDesktop(args.desktop, browserWindowId, args.requestedScreen, args.requestTimeoutMs);
      if (physicalWindow === undefined) {
        // Keep the last measured bad state; a missing observation cannot prove a successful fix.
        physicalWindow = before;
        unusable = `Physical browser containment could not be verified after correction for lane ${args.laneId}; the last measured window was clipped.`;
      } else if (isBrowserWindowContained(physicalWindow, args.requestedScreen)) {
        warnings.push(`Browser window clipping corrected for lane ${args.laneId}; physical bounds are ${physicalWindow.width}x${physicalWindow.height} at (${physicalWindow.x}, ${physicalWindow.y}).`);
      }
    }
    if (unusable === undefined && !isBrowserWindowContained(physicalWindow, args.requestedScreen)) {
      unusable = `Browser window is outside the captured ${args.requestedScreen[0]}x${args.requestedScreen[1]} desktop for lane ${args.laneId}: physical bounds ${physicalWindow.width}x${physicalWindow.height} at (${physicalWindow.x}, ${physicalWindow.y}), right=${physicalWindow.x + physicalWindow.width}, bottom=${physicalWindow.y + physicalWindow.height}.`;
    }
    if (unusable !== undefined) warnings.push(unusable);
  }
  if (physicalWindow === undefined) {
    warnings.push(`Physical browser containment is unverified for lane ${args.laneId}; X window bounds could not be measured. Page-reported outer dimensions can be emulated and do not prove physical visibility.`);
  }

  let cdpUnavailable: string | undefined;
  const chromeGeometry = args.browserFamily === "chromium"
    ? await makeChromeDesktopGeometryObserver(
      args.desktop,
      args.requestTimeoutMs,
      {
        ...(args.launchIdentity?.cdpPort === undefined ? {} : { cdpPort: args.launchIdentity.cdpPort }),
        ...(args.launchIdentity?.profileDir === undefined ? {} : { profileDir: args.launchIdentity.profileDir }),
        targetUrl: args.targetUrl
      },
      args.browserTargetId,
      (reason) => {
        cdpUnavailable = reason;
      },
      args.pagePreference ?? "pinned"
    )().catch((error: unknown) => {
      cdpUnavailable = toErrorMessage(error);
      return undefined;
    })
    : undefined;
  const browserWindow = physicalWindow ?? chromeGeometry?.browserWindow;
  const viewport = chromeGeometry?.viewport;
  // The fill check reads the X window when it was measured: under mobile emulation (#221) the
  // page's window.outerWidth reports the EMULATED screen (414), which is not a fill failure.
  const fillBounds = physicalWindow;
  if (!browserWindow) {
    warnings.push(`Browser outer bounds could not be measured for lane ${args.laneId}.`);
  } else if (unusable === undefined && fillBounds !== undefined && (fillBounds.x !== 0 || fillBounds.y !== 0 || fillBounds.width !== args.requestedScreen[0] || fillBounds.height !== args.requestedScreen[1])) {
    warnings.push(`Browser window fill did not reach the requested ${args.requestedScreen[0]}x${args.requestedScreen[1]} screen for lane ${args.laneId}; measured physical bounds are ${fillBounds.width}x${fillBounds.height} at (${fillBounds.x}, ${fillBounds.y}).`);
  }
  if (!viewport) {
    // Name the cause, not only the symptom: the same dead DevTools channel that loses the viewport
    // loses every url/text observation, and a reader of the bundle should learn that here (#514).
    const cause = cdpUnavailable === undefined ? "" : ` DevTools probe: ${redactText(cdpUnavailable)}.`;
    warnings.push(args.browserFamily === "firefox"
      ? `Browser CSS viewport measurement is unavailable for Firefox on lane ${args.laneId}; stream.viewport is omitted instead of reading a different browser's CDP endpoint.`
      : `Browser CSS viewport could not be measured for lane ${args.laneId}; stream.viewport is omitted instead of copying the requested screen resolution.${cause}`);
  }
  return {
    ...(unusable === undefined ? {} : { unusable }),
    ...(browserWindowId === undefined ? {} : { browserWindowId }),
    ...(chromeGeometry?.targetId === undefined ? {} : { browserTargetId: chromeGeometry.targetId }),
    ...(browserWindow === undefined ? {} : { browserWindow }),
    ...(viewport === undefined ? {} : { viewport }),
    warnings
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Prepare a CLI study's runtime and, only when declared, its product (#495, #515).
 *
 * The install runs UNKEYED and before the session starts, for the same reason the clone route
 * provisions its subject first: what is being studied begins when the participant looks at the
 * screen. Omitting install deliberately studies product installation; Node/npm remain a
 * harness prerequisite so the participant can follow the product's public npm instructions.
 */
export async function provisionDesktopCli(
  desktop: E2BDesktopSandbox,
  args: {
    product: string;
    install?: string;
    requestTimeoutMs: number;
    scrub: (value: string) => string;
    onPhase?: (event: SubjectPhaseEvent) => void;
  }
): Promise<void> {
  const install = args.install;
  const now = (): number => Date.now();
  if (install === undefined || needsNodeRuntime([install])) {
    const startedAt = now();
    emitPhaseStarted(args.onPhase, now, "runtime", "providing Node/npm for the desktop CLI study");
    const bootstrap = await runDetachedStep(desktop, {
      name: "desktop-cli-runtime-node",
      command: TERMINAL_NODE_BOOTSTRAP_COMMAND,
      cwd: "/home/user",
      timeoutMs: INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs
    });
    emitPhaseCompleted(args.onPhase, now, startedAt, "runtime", bootstrap.ok, bootstrap.ok
      ? "Node runtime ready"
      : "Node runtime bootstrap failed");
    if (!bootstrap.ok) {
      throw new Error(`desktop-cli runtime bootstrap failed for "${args.product}"`);
    }
  }
  if (install === undefined) return;
  const startedAt = now();
  emitPhaseStarted(args.onPhase, now, "install", `installing ${args.product} on the desktop`);
  const result = await runDetachedStep(desktop, {
    name: "desktop-cli-install",
    command: install,
    cwd: "/home/user",
    timeoutMs: INSTALL_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs
  });
  emitPhaseCompleted(args.onPhase, now, startedAt, "install", result.ok, result.ok
    ? `${args.product} installed`
    : `installing ${args.product} failed`);
  if (!result.ok) {
    // Fail closed: a participant handed a desktop where the product is not installed would produce
    // a transcript about a missing command, and that finding belongs to the harness, not the tool.
    // The tail rides along, scrubbed before truncation like every other provisioning failure — a
    // bare "install failed" is unactionable to whoever wrote the command.
    throw new Error(args.scrub(
      `desktop-cli install failed for "${args.product}" (${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`}): ${tailOf(args.scrub(result.logTail))}`
    ));
  }
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
  workdir: string | undefined
): Promise<void> {
  const dir = workdir ?? "/home/user";
  const result = await runDetachedStep(desktop, {
    name: "desktop-cli-terminal",
    command: [
      "for candidate in x-terminal-emulator xfce4-terminal gnome-terminal konsole xterm; do",
      '  if command -v "$candidate" >/dev/null 2>&1; then',
      // LANG is set on the terminal we open, not globally: the stock image declares no locale, and
      // a study that measures our own mojibake against an unconfigured template would be measuring
      // the template. The PRODUCT-side fix (an ASCII fallback when the locale is not UTF-8) is in
      // src/terminal-encoding.ts, and it is the one that matters for real users.
      `    (cd ${shellSingleQuote(dir)} 2>/dev/null || cd /home/user; DISPLAY=:0 LANG=C.UTF-8 LC_ALL=C.UTF-8 HUMANISH_STUDY_PARTICIPANT=1 nohup "$candidate" >/dev/null 2>&1 &)`,
      "    sleep 3",
      '    echo "humanish: opened $candidate"',
      "    exit 0",
      "  fi",
      "done",
      "echo 'humanish: no terminal emulator on this desktop template' >&2",
      "exit 1"
    ].join("\n"),
    cwd: "/home/user",
    timeoutMs: 60_000,
    requestTimeoutMs
  });
  if (!result.ok) {
    throw new Error("desktop-cli lane could not open a terminal on this desktop template");
  }
}

export async function startDesktopStream(
  desktop: E2BDesktopSandbox,
  browserWindowId: string | undefined
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

/**
 * Shared post-populate provisioning pipeline (clone AND local-tree routes): (install) ->
 * state(before-build) -> (build) -> state(before-start) -> detached start -> readiness probe ->
 * state(after-ready). Both provisioning routes populate SUBJECT_DIR by different means (git
 * clone vs. upload+extract) and then run this identical pipeline unchanged.
 *
 * State steps run through the same detached primitive as serve steps (author-trusted, the
 * "serve commands are author-trusted" corollary) under the reserved `subject-state-<name>`
 * label prefix, so a step name can never collide with subject-clone/subject-extract/install/
 * build/start. after-ready steps complete BEFORE the caller opens the browser: the actor never
 * drives a half-seeded subject and seeding never eats the session budget.
 */
async function runSubjectServePipeline(
  desktop: E2BDesktopSandbox,
  args: {
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment each state step finishes, success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): install, build, serve start, ready,
     *  and each subject.state seed-step group (one pair per group, never per step). */
    onPhase?: (event: SubjectPhaseEvent) => void;
    /** Called after every phase completes. The clone route re-resolves HEAD here; the
     *  local-tree route omits this entirely (identity is the host-side archive digest, never
     *  an in-sandbox git refresh, because the archive excludes .git). */
    onPhaseComplete?: () => Promise<void>;
  } & DetachedTimers
): Promise<void> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const now = args.now ?? Date.now;
  const refresh = args.onPhaseComplete ?? ((): Promise<void> => Promise.resolve());
  const stateSteps = args.state?.seed ?? [];
  const runStateSteps = async (when: LabStateStepWhen): Promise<void> => {
    const steps = stateSteps.filter((step) => (step.when ?? "before-start") === when);
    if (steps.length === 0) {
      // No declared steps for this group: no boundary to report (avoids empty-group noise on
      // every run, since before-build/before-start/after-ready are always called).
      return;
    }
    const groupStartedAt = now();
    emitPhaseStarted(args.onPhase, now, `state.${when}`, `running subject state seed steps (${when})`);
    for (const step of steps) {
      const stepTimeoutMs = step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS;
      const startedAt = now();
      const result = await runDetachedStep(desktop, {
        name: `subject-state-${step.name}`,
        command: step.command,
        cwd: SUBJECT_DIR,
        timeoutMs: stepTimeoutMs,
        requestTimeoutMs: args.requestTimeoutMs,
        ...timers
      });
      args.onStateStep?.({
        name: step.name,
        when,
        // Digest only (sha256-16): the command text never persists: the lab YAML in the
        // consumer's repo is the plaintext source of truth.
        commandDigest: commandDigestOf(step.command),
        ok: result.ok,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.timedOut ? { timedOut: true } : {}),
        durationMs: Math.max(0, now() - startedAt)
      });
      if (!result.ok) {
        emitPhaseCompleted(args.onPhase, now, groupStartedAt, `state.${when}`, false, `subject state seed steps failed (${when})`);
        // Fail closed with the existing scrub-before-truncate tail chain: literal scrub of
        // every provisioned value PRE-truncation, then pattern redaction + cap in tailOf.
        throw new Error(`subject state step "${step.name}" ${result.timedOut ? `timed out after ${stepTimeoutMs}ms` : `failed (exit ${result.exitCode})`}: ${tailOf(args.scrub(result.logTail))}`);
      }
    }
    emitPhaseCompleted(args.onPhase, now, groupStartedAt, `state.${when}`, true, `subject state seed steps complete (${when})`);
  };

  // Provide the runtime the pipeline needs before running it (#371). The stock desktop template
  // ships python3 and curl but no Node, so an `npm install` here used to die at exit 127 after the
  // sandbox was already paid for. Probe-first, so a template that ships its own Node pays nothing.
  const serveCommands = [args.serve.install, args.serve.build, args.serve.start];
  if (needsNodeRuntime(serveCommands)) {
    const runtimeStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "runtime", "providing the Node runtime the serve pipeline needs");
    const bootstrap = await runProvisioningStepWithOneRetry(desktop, {
      name: "subject-runtime-node",
      command: nodeBootstrapCommand(),
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      timers,
      retryPhase: "runtime-retry",
      retryMessage: "Node runtime bootstrap",
      onPhase: args.onPhase,
      now
    });
    let ok = bootstrap.ok;
    const corepack = ok ? corepackCommandFor(serveCommands) : undefined;
    if (corepack) {
      const pm = await runDetachedStep(desktop, {
        name: "subject-runtime-pm",
        command: corepack,
        cwd: SUBJECT_DIR,
        timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
        requestTimeoutMs: args.requestTimeoutMs,
        ...timers
      });
      ok = pm.ok;
    }
    emitPhaseCompleted(
      args.onPhase,
      now,
      runtimeStartedAt,
      "runtime",
      ok,
      ok ? "Node runtime ready" : "could not provide a Node runtime"
    );
    if (!ok) {
      throw new Error(
        `the subject's serve pipeline needs a Node runtime and this desktop template has none, and bootstrapping one failed${bootstrap.attempts === 2 ? " twice" : ""}: ${tailOf(args.scrub(bootstrap.logTail))}. Use execution.desktop.template with an image that ships Node, or change serve.install to a runtime the template provides.`
      );
    }
  }

  if (args.serve.install) {
    const installStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "install", "installing subject dependencies");
    const install = await runProvisioningStepWithOneRetry(desktop, {
      name: "subject-install",
      command: args.serve.install,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      timers,
      retryPhase: "install-retry",
      retryMessage: "subject install",
      onPhase: args.onPhase,
      now
    });
    emitPhaseCompleted(
      args.onPhase,
      now,
      installStartedAt,
      "install",
      install.ok,
      install.ok
        ? install.attempts === 2
          ? "subject dependencies installed (on the second attempt)"
          : "subject dependencies installed"
        : install.attempts === 2
          ? "subject install failed twice"
          : "subject install failed"
    );
    if (!install.ok) {
      // Lead with the line a person can act on; npm's own trace follows it (#602).
      const headline = install.timedOut
        ? `subject install timed out after ${args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS}ms`
        : install.attempts === 2
          ? `subject install failed twice (exit ${install.firstExitCode ?? "null"}, then exit ${install.exitCode ?? "null"}); the sandbox could not complete serve.install`
          : `subject install failed (exit ${install.exitCode ?? "null"})`;
      throw new Error(`${headline}: ${tailOf(args.scrub(install.logTail))}`);
    }
    await refresh();
  }

  // before-build: after install, before build (builds that read seeded state, e.g. SSG).
  // When no build is declared this simply precedes start: equivalent to before-start.
  await runStateSteps("before-build");
  await refresh();

  if (args.serve.build) {
    const buildStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "build", "building subject");
    const build = await runDetachedStep(desktop, {
      name: "subject-build",
      command: args.serve.build,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers
    });
    emitPhaseCompleted(args.onPhase, now, buildStartedAt, "build", build.ok, build.ok ? "subject build complete" : "subject build failed");
    if (!build.ok) {
      throw new Error(`subject build ${build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`}: ${tailOf(args.scrub(build.logTail))}`);
    }
    await refresh();
  }

  // before-start (the default phase): migrations, SQL/file fixtures, an in-sandbox DB server
  // (`sudo service postgresql start && pg_isready` is a bounded step; the daemon it forks is
  // reclaimed by the sandbox lifecycle like everything else).
  await runStateSteps("before-start");
  await refresh();

  await startDetachedProcess(desktop, {
    name: "subject-start",
    command: args.serve.start,
    cwd: SUBJECT_DIR,
    requestTimeoutMs: args.requestTimeoutMs
  });
  // Fire-and-forget: startDetachedProcess never waits for the long-lived server to exit, so
  // there is no matching completed event here (no ok/durationMs to report yet); readiness is
  // the next boundary.
  args.onPhase?.({ at: isoNow(now), type: "cua-lab.subject.serve.started", message: "subject server launched (detached)" });

  const readyStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "ready", "waiting for subject to become ready");
  const ready = await probeUrl(desktop, args.serve.url, {
    timeoutMs: args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  emitPhaseCompleted(args.onPhase, now, readyStartedAt, "ready", ready, ready ? "subject is ready" : "subject did not become ready in time");
  if (!ready) {
    const startLog = await readDetachedLog(desktop, "subject-start", args.requestTimeoutMs).catch(() => "");
    throw new Error(`subject did not answer at ${args.serve.url} within ${args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms; server log tail: ${tailOf(args.scrub(startLog))}`);
  }

  // after-ready: fixture loading through the RUNNING app (loopback curl from in-sandbox:
  // steps are author-trusted provisioning, not actors, so no new URL policy surface). These
  // complete before the caller opens the browser and the session timer starts.
  await runStateSteps("after-ready");
  await refresh();
}

/**
 * Provision a clone subject inside the sandbox: clone → the shared serve pipeline
 * (install → state(before-build) → build → state(before-start) → start → readiness
 * probe → state(after-ready)). Returns the latest subject HEAD after successful
 * provisioning. Throws (with a capped log tail for the caller to redact) on any failing step:
 * the lab persists that as a failed-evidence bundle.
 *
 * Auth: when GITHUB_TOKEN is among the declared subject env names, the clone authenticates
 * via an Authorization header computed IN-SANDBOX from the provisioned env: the token never
 * appears in the script text, the process argv beyond the transient git call, the clone URL,
 * or .git/config.
 */
export async function provisionCloneSubject(
  desktop: E2BDesktopSandbox,
  args: {
    repo: string;
    depth: number;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    hasGithubToken: boolean;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment the cloned commit resolves, so provenance survives later failures. */
    onCommit?: (commit: string) => void;
    /** Called the moment each state step finishes (mirrors onCommit), success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): clone, install, build, serve start,
     *  ready, and each subject.state seed-step group. */
    onPhase?: (event: SubjectPhaseEvent) => void;
  } & DetachedTimers
): Promise<string | undefined> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const now = args.now ?? Date.now;
  let latestCommit: string | undefined;
  const refreshCommit = async (): Promise<void> => {
    const head = await desktop.commands.run(
      `git -C ${SUBJECT_DIR} rev-parse HEAD 2>/dev/null || true`,
      { requestTimeoutMs: args.requestTimeoutMs }
    );
    const commit = (head.stdout ?? "").trim() || undefined;
    if (commit) {
      latestCommit = commit;
      args.onCommit?.(commit);
    }
  };

  const cloneCommand = args.hasGithubToken
    ? `auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0) && git -c http.extraHeader="Authorization: Basic $auth" clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`
    : `git clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`;

  const cloneStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "clone", "cloning subject repository");
  const clone = await runDetachedStep(desktop, {
    name: "subject-clone",
    command: cloneCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  emitPhaseCompleted(args.onPhase, now, cloneStartedAt, "clone", clone.ok, clone.ok ? "subject repository cloned" : "subject clone failed");
  if (!clone.ok) {
    throw new Error(`subject clone ${clone.timedOut ? "timed out" : `failed (exit ${clone.exitCode})`}: ${tailOf(args.scrub(clone.logTail))}`);
  }

  await refreshCommit();

  await runSubjectServePipeline(desktop, {
    serve: args.serve,
    ...(args.state === undefined ? {} : { state: args.state }),
    requestTimeoutMs: args.requestTimeoutMs,
    scrub: args.scrub,
    ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
    ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
    onPhaseComplete: refreshCommit,
    ...timers
  });

  return latestCommit;
}

/**
 * Provision a local-tree subject inside the sandbox: upload the once-per-run packed archive
 * (identical bytes across every fan-out lane) → extract it into SUBJECT_DIR → the
 * same shared serve pipeline provisionCloneSubject uses. Unlike the clone route there is no
 * in-sandbox git refresh: the archive excludes .git entirely (see source-archive.ts), so
 * subject identity is the host-side LocalTreeArchive captured at pack time, never anything
 * resolved in-sandbox.
 */
export async function provisionLocalTreeSubject(
  desktop: E2BDesktopSandbox,
  args: {
    /** The once-per-run packed archive bytes (shared byte-identically across every lane). */
    archiveBuffer: ArrayBuffer;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment each state step finishes, success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): upload, extract, install, build,
     *  serve start, ready, and each subject.state seed-step group. */
    onPhase?: (event: SubjectPhaseEvent) => void;
  } & DetachedTimers
): Promise<void> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const now = args.now ?? Date.now;

  const uploadStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "upload", "uploading packed local-tree archive");
  try {
    await withOneRetryOnTransientE2BError(
      () =>
        desktop.files.write(LOCAL_TREE_REMOTE_ARCHIVE_PATH, args.archiveBuffer, {
          requestTimeoutMs: args.requestTimeoutMs,
          useOctetStream: true
        }),
      {
        onRetry: (reason) => emitPhaseStarted(args.onPhase, now, "upload-retry", `local-tree archive upload retried once (${tailOf(args.scrub(reason))})`),
        ...(args.sleep === undefined ? {} : { sleep: args.sleep })
      }
    );
  } catch (error) {
    emitPhaseCompleted(args.onPhase, now, uploadStartedAt, "upload", false, "local-tree archive upload failed");
    throw new Error(`subject-upload failed: ${tailOf(args.scrub(toErrorMessage(error)))}`);
  }
  emitPhaseCompleted(args.onPhase, now, uploadStartedAt, "upload", true, "local-tree archive uploaded");

  const extractCommand = `rm -rf ${SUBJECT_DIR} && mkdir -p ${SUBJECT_DIR} && tar -xzf ${LOCAL_TREE_REMOTE_ARCHIVE_PATH} -C ${SUBJECT_DIR} && rm -f ${LOCAL_TREE_REMOTE_ARCHIVE_PATH}`;
  const extractStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "extract", "extracting local-tree archive");
  const extract = await runDetachedStep(desktop, {
    name: "subject-extract",
    command: extractCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  emitPhaseCompleted(args.onPhase, now, extractStartedAt, "extract", extract.ok, extract.ok ? "local-tree archive extracted" : "local-tree archive extraction failed");
  if (!extract.ok) {
    throw new Error(`subject extract ${extract.timedOut ? "timed out" : `failed (exit ${extract.exitCode})`}: ${tailOf(args.scrub(extract.logTail))}`);
  }

  await runSubjectServePipeline(desktop, {
    serve: args.serve,
    ...(args.state === undefined ? {} : { state: args.state }),
    requestTimeoutMs: args.requestTimeoutMs,
    scrub: args.scrub,
    ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
    ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
    ...timers
  });
}

/** sha256 hex of the exact command string, first 16 chars (the promptDigest convention). */
export function commandDigestOf(command: string): string {
  return digestText(command, 16);
}

// The in-sandbox `tail -c` upstream is a fundamental log-tail limit we cannot redact past.
function tailOf(log: string): string {
  return redactedTail(log, ERROR_TAIL_CHARS);
}
