import { fullScreenXwininfo } from "./full-screen-xwininfo.js";

type Answer = { exitCode: number; stdout: string };

/**
 * A command handler for a fake E2B desktop whose hosted Chrome reports measured geometry. It
 * answers the shell commands a hosted computer-use participant sends to launch and measure its
 * browser (src/substrates/e2b/desktop-browser.ts and desktop-geometry.ts): Chrome launches with
 * DevTools, its window fills the screen, and the page reports a viewport below an 87 px toolbar
 * on the URL it was launched with. A desktop that uses it records measured geometry and no
 * geometry warnings; one that answers nothing keeps the unmeasured path. `screen` is read on each
 * command, so a fake can set it when the sandbox is created. Other commands get undefined.
 */
export function measuredChromeDesktop(
  screen: () => readonly [number, number] | undefined,
): (command: string) => Answer | undefined {
  let pageUrl = "about:blank";
  return (command) => {
    const size = screen();
    if (size === undefined) return undefined;
    const [width, height] = size;
    // Every CDP probe command embeds the whole probe script, so match its JSON arguments first.
    if (command.includes('"mode":"geometry"'))
      return probe({
        browserWindow: { x: 0, y: 0, width, height },
        viewport: { width, height: height - CHROME_TOOLBAR_PX, deviceScaleFactor: 1 },
      });
    if (command.includes('"mode":"state"'))
      return probe({ url: pageUrl, title: "app", text: "", scrollY: 0 });
    if (command.includes("xdpyinfo"))
      return { exitCode: 0, stdout: `  dimensions:    ${width}x${height} pixels\n` };
    if (command.includes("browser_preference=")) {
      pageUrl = command.match(/^target_url='([^']+)'$/m)?.[1] ?? pageUrl;
      return { exitCode: 0, stdout: LAUNCHED };
    }
    if (command.includes("find_chrome_window"))
      return { exitCode: 0, stdout: "WINDOW_ID=4194307\n" };
    if (command.includes("xwininfo -id"))
      return { exitCode: 0, stdout: fullScreenXwininfo(width, height) };
    return undefined;
  };
}

const CHROME_TOOLBAR_PX = 87;

const LAUNCHED = [
  "HUMANISH_BROWSER_RESOLVED=google-chrome",
  "HUMANISH_BROWSER_PID=4242",
  "HUMANISH_BROWSER_PROFILE_DIR=/tmp/humanish-chrome-profile.fake",
  "HUMANISH_BROWSER_CDP_PORT=9222",
  "HUMANISH_BROWSER_CDP_READY_MS=100",
  "",
].join("\n");

function probe(value: Record<string, unknown>): Answer {
  return { exitCode: 0, stdout: `${JSON.stringify({ ...value, targetId: "page-1" })}\n` };
}
