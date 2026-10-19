// A desktop in a Modal sandbox, with @e2b/desktop's behavior: the same Xvfb and XFCE start, the
// same xdotool commands for each input, scrot for screenshots and x11vnc behind noVNC for the live
// stream. The executor and every e2b-desktop module were tuned against that SDK, so this follows it
// command for command (the Sandbox class of @e2b/desktop 2.4.0) rather than improving on it.
import { randomBytes } from "node:crypto";

import type { E2BCommandResult, E2BCommandRunOptions, E2BDesktopSandbox } from "../e2b/sdk.js";
import { shellQuote } from "../shell.js";

type Run = (command: string, options?: E2BCommandRunOptions) => Promise<E2BCommandResult>;

/** The X display and the ports the desktop's stream uses, as @e2b/desktop sets them. */
export const MODAL_DESKTOP_DISPLAY = ":0";
const VNC_PORT = 5900;
export const MODAL_STREAM_PORT = 6080;

const KEYS: Readonly<Record<string, string>> = {
  alt: "Alt_L",
  alt_left: "Alt_L",
  alt_right: "Alt_R",
  backspace: "BackSpace",
  break: "Pause",
  caps_lock: "Caps_Lock",
  cmd: "Super_L",
  command: "Super_L",
  control: "Control_L",
  control_left: "Control_L",
  control_right: "Control_R",
  ctrl: "Control_L",
  del: "Delete",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
  home: "Home",
  insert: "Insert",
  left: "Left",
  menu: "Menu",
  meta: "Meta_L",
  num_lock: "Num_Lock",
  page_down: "Page_Down",
  page_up: "Page_Up",
  pause: "Pause",
  print: "Print",
  right: "Right",
  scroll_lock: "Scroll_Lock",
  shift: "Shift_L",
  shift_left: "Shift_L",
  shift_right: "Shift_R",
  space: "space",
  super: "Super_L",
  super_left: "Super_L",
  super_right: "Super_R",
  tab: "Tab",
  up: "Up",
  win: "Super_L",
  windows: "Super_L",
};

const mapKey = (key: string): string => KEYS[key.toLowerCase()] ?? key.toLowerCase();

/** Run `command` every `intervalMs` until it exits 0, for at most `timeoutMs`. */
async function waitUntil(run: Run, command: string, timeoutMs: number, intervalMs = 500) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    try {
      await run(command);
      return true;
    } catch (error) {
      if ((error as { name?: unknown }).name !== "CommandExitError") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Start Xvfb at the requested size, then an XFCE session, as @e2b/desktop's create does. */
export async function startModalDesktop(
  run: Run,
  options: { resolution?: [number, number]; dpi?: number },
): Promise<void> {
  const [width, height] = options.resolution ?? [1024, 768];
  const display = MODAL_DESKTOP_DISPLAY;
  await run(
    `setsid -f Xvfb ${display} -ac -screen 0 ${width}x${height}x24 -retro -dpi ${options.dpi ?? 96} -nolisten tcp -nolisten unix </dev/null >/tmp/xvfb.log 2>&1`,
  );
  if (!(await waitUntil(run, `xdpyinfo -display ${display} >/dev/null`, 10_000)))
    throw new Error("Could not start Xvfb");
  await run("setsid -f startxfce4 </dev/null >/tmp/xfce4.log 2>&1");
  if (
    !(await waitUntil(
      run,
      "pgrep -x xfce4-session >/dev/null && pgrep -x xfwm4 >/dev/null && pgrep -x xfdesktop >/dev/null",
      60_000,
      1_000,
    ))
  )
    throw new Error("Could not start XFCE");
}

/**
 * The desktop half of a sandbox handle. `hosts` maps each tunneled port to the host Modal serves it
 * on; `readBytes` reads a file in the sandbox.
 */
export function modalDesktopSurface(
  run: Run,
  readBytes: (path: string) => Promise<Uint8Array>,
  hosts: ReadonlyMap<number, string>,
): Omit<E2BDesktopSandbox, "sandboxId" | "getInfo" | "commands" | "files"> {
  const getHost = (port: number): string => {
    const host = hosts.get(port);
    if (host === undefined) throw new Error(`Port ${port} has no Modal tunnel in this sandbox.`);
    return host;
  };
  const moveMouse = async (x: number, y: number) => {
    await run(`xdotool mousemove --sync ${x} ${y}`);
  };
  // The SDK moves only when both coordinates are truthy, so a click at x or y 0 clicks in place.
  const clickAt = async (x: number | undefined, y: number | undefined, click: string) => {
    if (x && y) await moveMouse(x, y);
    await run(`xdotool click ${click}`);
  };
  let streamUrl: URL | undefined;
  let password: string | undefined;
  return {
    getHost,
    async screenshot() {
      const path = `/tmp/screenshot-${randomBytes(8).toString("hex")}.png`;
      await run(`scrot --pointer ${path}`);
      try {
        return await readBytes(path);
      } finally {
        void run(`rm -f ${path}`).catch(() => {});
      }
    },
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    leftClick: (x, y) => clickAt(x, y, "1"),
    rightClick: (x, y) => clickAt(x, y, "3"),
    middleClick: (x, y) => clickAt(x, y, "2"),
    doubleClick: (x, y) => clickAt(x, y, "--repeat 2 1"),
    moveMouse,
    async getCursorPosition() {
      const result = await run("xdotool getmouselocation");
      const match = (result.stdout ?? "").match(/x:(\d+)\s+y:(\d+)/);
      if (!match) throw new Error(`Failed to parse cursor position from output: ${result.stdout}`);
      return { x: Number.parseInt(match[1]!, 10), y: Number.parseInt(match[2]!, 10) };
    },
    async scroll(direction = "down", amount = 1) {
      await run(`xdotool click --repeat ${amount} ${direction === "up" ? "4" : "5"}`);
    },
    async write(text: string) {
      for (let at = 0; at < text.length; at += 25)
        await run(`xdotool type --delay 75 -- ${shellQuote(text.slice(at, at + 25))}`);
    },
    async press(key: string | string[]) {
      await run(`xdotool key ${Array.isArray(key) ? key.map(mapKey).join("+") : mapKey(key)}`);
    },
    async drag(from: [number, number], to: [number, number]) {
      await moveMouse(...from);
      await run("xdotool mousedown 1");
      await moveMouse(...to);
      await run("xdotool mouseup 1");
    },
    async open(fileOrUrl: string) {
      await run(`setsid -f xdg-open ${fileOrUrl} </dev/null >/dev/null 2>&1`);
    },
    async launch(application: string, uri?: string) {
      await run(`setsid -f gtk-launch ${application} ${uri ?? ""} </dev/null >/dev/null 2>&1`);
    },
    stream: {
      getAuthKey() {
        if (password === undefined)
          throw new Error("Unable to retrieve stream auth key, check if requireAuth is enabled");
        return password;
      },
      getUrl({ autoConnect = true, viewOnly = false, resize = "scale", authKey } = {}) {
        if (streamUrl === undefined) throw new Error("Server is not running");
        const url = new URL(streamUrl);
        if (autoConnect) url.searchParams.set("autoconnect", "true");
        if (viewOnly) url.searchParams.set("view_only", "true");
        if (resize) url.searchParams.set("resize", resize);
        if (authKey) url.searchParams.set("password", authKey);
        return url.toString();
      },
      async start({ requireAuth = false, windowId } = {}) {
        password = requireAuth ? randomBytes(12).toString("base64url") : undefined;
        streamUrl = new URL(`https://${getHost(MODAL_STREAM_PORT)}/vnc.html`);
        if (password !== undefined)
          await run(`mkdir -p ~/.vnc && x11vnc -storepasswd ${password} ~/.vnc/passwd`);
        await run(
          `x11vnc -bg -display ${MODAL_DESKTOP_DISPLAY} -forever -wait 50 -shared -rfbport ${VNC_PORT} ${password === undefined ? "-nopw" : "-usepw"} 2>/tmp/x11vnc_stderr.log${windowId === undefined ? "" : ` -id ${windowId}`}`,
        );
        await run(
          `setsid -f websockify --web /usr/share/novnc ${MODAL_STREAM_PORT} localhost:${VNC_PORT} </dev/null >/tmp/novnc.log 2>&1`,
        );
        if (!(await waitUntil(run, `netstat -tuln | grep ":${MODAL_STREAM_PORT} "`, 10_000)))
          throw new Error("Could not start noVNC server");
      },
    },
  };
}
