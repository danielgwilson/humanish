// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";

// A served page whose server process exits: the feed poll gets no response at all.
let container: HTMLDivElement, root: Root, serving: boolean, data: ObserverData;

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const failTileImages = async () => {
  await act(async () => {
    for (const image of container.querySelectorAll(".card img"))
      image.dispatchEvent(new Event("error"));
  });
};
const notice = () => container.querySelector(".server-stopped");

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime("2026-10-05T12:00:00.000Z");
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  serving = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, "fetch").mockImplementation(async (input) => {
    if (!serving) throw new TypeError("Failed to fetch");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url === "observer-data.json"
      ? new Response(JSON.stringify(data))
      : new Response(null, { status: 404 });
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

async function mountAndStopServer() {
  await act(async () => {
    root.render(<App data={data} />);
  });
  await advance(0);
  serving = false;
}

describe("an open Observer page whose server stopped", () => {
  it("keeps the tile message for one missing frame while the server answers", async () => {
    data = fixtures.fixture() as unknown as ObserverData;
    await act(async () => {
      root.render(<App data={data} />);
    });
    await advance(0);
    await failTileImages();
    expect(container.querySelector(".card .frame-unavailable")?.textContent).toBe(
      "Frame unavailable",
    );
    await advance(15_000);
    expect(notice()).toBeNull();
  });

  it("names the run and both ways back after a finished run, with no failed tiles", async () => {
    data = fixtures.fixture() as unknown as ObserverData;
    const runId = data.run.runId;
    await mountAndStopServer();
    // One unanswered poll is not yet a stopped server.
    await advance(5000);
    expect(notice()).toBeNull();
    expect(container.textContent).toContain("Updates unavailable");
    await advance(10_000);
    const text = notice()?.textContent ?? "";
    expect(text).toContain("The Observer server stopped answering");
    expect(text).toContain("The run had ended");
    expect(text).toContain(`humanish observe --run ${runId}`);
    expect(text).toContain(`.humanish/runs/${runId}/observer/index.html`);
    expect(container.querySelector(".topbar")?.textContent).toContain("Server stopped");
    await failTileImages();
    expect(container.textContent).not.toContain("Frame unavailable");
    expect(container.querySelector(".card-retry")).toBeNull();
    // A server that answers again clears the notice and asks for the frames again.
    serving = true;
    await advance(5000);
    expect(notice()).toBeNull();
    expect(container.textContent).not.toContain("Frame unavailable");
  });

  it("says the run was still running when the server of a live run stopped", async () => {
    data = fixtures.fixture({ running: true }) as unknown as ObserverData;
    await mountAndStopServer();
    await advance(15_000);
    const text = notice()?.textContent ?? "";
    expect(text).toContain("the run was still running");
    expect(text).toContain(`humanish observe --run ${data.run.runId}`);
    await failTileImages();
    expect(container.textContent).not.toContain("Frame unavailable");
  });

  it("does not blame the server while the browser reports no network", async () => {
    data = fixtures.fixture() as unknown as ObserverData;
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mountAndStopServer();
    await advance(20_000);
    expect(notice()).toBeNull();
    expect(container.textContent).toContain("Updates unavailable");
    online.mockRestore();
  });
});
