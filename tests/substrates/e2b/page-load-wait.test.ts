// The launch page's load wait, run the way a hosted desktop runs it: the shipped shell command,
// the real python3 and a real headless Chrome. It replaced a fixed 8 s sleep before the first
// screenshot, so each case checks what that sleep was for: the page has loaded and painted.
// Chrome-backed cases skip where no Chrome binary exists.
import { execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForChromePageLoad } from "../../../src/substrates/e2b/desktop-cdp.js";
import type { E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import {
  findChrome,
  hasPython3,
  launchReadableChrome,
  stopChrome,
} from "../../helpers/readable-chrome.js";

const execFileAsync = promisify(execFile);
const live = hasPython3() && findChrome() !== undefined;

/** A desktop whose commands run on this machine's shell, where the headless Chrome is. */
const localDesktop = {
  commands: { run: async (command: string) => execFileAsync("sh", ["-c", command]) },
} as unknown as E2BDesktopSandbox;

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const LATE_IMAGE_MS = 2_000;

describe("the launch page's load wait against a real headless Chrome", () => {
  let server: Server | undefined;
  let origin = "";
  let browser: ChildProcess | undefined;
  let profileDir = "";
  let cdpPort = 0;
  let lateImageSentAt = 0;
  const hanging: ServerResponse[] = [];

  beforeAll(async () => {
    if (!live) return;
    server = createServer((request, response) => {
      if (request.url === "/late.png") {
        setTimeout(() => {
          lateImageSentAt = Date.now();
          response.setHeader("content-type", "image/png");
          response.end(PIXEL);
        }, LATE_IMAGE_MS);
        return;
      }
      if (request.url === "/hang.png") {
        hanging.push(response);
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      const image =
        request.url === "/slow" ? "/late.png" : request.url === "/never" ? "/hang.png" : "";
      response.end(
        `<html><head><title>load page</title></head><body><h1>text paints first</h1>${image ? `<img src="${image}">` : ""}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const launch = await launchReadableChrome(findChrome()!, `${origin}/`, 60_000);
    if (!launch.chrome)
      throw new Error(`headless Chrome never read back: ${launch.failures.join("; ")}`);
    ({ browser, profileDir, cdpPort } = launch.chrome);
  }, 120_000);

  afterAll(async () => {
    for (const response of hanging) response.destroy();
    await stopChrome(browser, profileDir);
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }, 20_000);

  /** Opens `url` in a new foreground tab, the way a participant's launch opens its target. */
  async function openTab(url: string): Promise<string> {
    const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${url}`, { method: "PUT" });
    const { id } = (await created.json()) as { id: string };
    await fetch(`http://127.0.0.1:${cdpPort}/json/activate/${id}`);
    return id;
  }

  it.skipIf(!live)(
    "answers once the page's last subresource has arrived and the page has painted",
    async () => {
      const url = `${origin}/slow`;
      const tab = await openTab(url);
      try {
        const load = await waitForChromePageLoad(
          localDesktop,
          5_000,
          { cdpPort, targetUrl: url },
          8_000,
        );
        const answeredAt = Date.now();
        expect(load).toMatchObject({ loaded: true });
        // The image held document.readyState at interactive until the server sent it.
        expect(lateImageSentAt).toBeGreaterThan(0);
        expect(answeredAt).toBeGreaterThanOrEqual(lateImageSentAt);
        expect(load!.waitedMs).toBeLessThan(8_000);
      } finally {
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab}`).catch(() => undefined);
      }
    },
    30_000,
  );

  it.skipIf(!live)(
    "gives up at its deadline on a page that never finishes loading, and says what it saw",
    async () => {
      const url = `${origin}/never`;
      const tab = await openTab(url);
      try {
        const load = await waitForChromePageLoad(
          localDesktop,
          5_000,
          { cdpPort, targetUrl: url },
          2_000,
        );
        expect(load).toMatchObject({ loaded: false });
        expect(load!.waitedMs).toBeGreaterThanOrEqual(2_000);
        expect(load!.seen).toMatch(/document\.readyState interactive/);
      } finally {
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab}`).catch(() => undefined);
      }
    },
    30_000,
  );

  it("reports nothing when the wait cannot run, so the caller keeps its fixed settle", async () => {
    const noPython = {
      commands: {
        run: async () => ({ exitCode: 127, stdout: "", stderr: "python3: not found" }),
      },
    } as unknown as E2BDesktopSandbox;
    expect(
      await waitForChromePageLoad(noPython, 5_000, { targetUrl: "http://127.0.0.1:1/" }, 8_000),
    ).toBeUndefined();
  });
});
