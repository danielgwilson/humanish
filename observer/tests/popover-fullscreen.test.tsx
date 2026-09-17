// @vitest-environment jsdom
import { Tooltip } from "@base-ui-components/react/tooltip";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Popover } from "../components/ui/popover";

let container: HTMLDivElement;
let root: Root;
let fullscreen: HTMLElement | null;
let originalFullscreen: PropertyDescriptor | undefined;

async function render(open = true) {
  await act(async () => {
    root.render(<Tooltip.Provider><div className="main"><Popover label="Playback options" triggerClassName="tbtn" trigger="Options" open={open}>
      <label>Speed<select aria-label="Study playback speed" defaultValue="1"><option value="1">1×</option><option value="2">2×</option></select></label>
    </Popover></div></Tooltip.Provider>);
  });
}

async function changeFullscreen(element: HTMLElement | null) {
  fullscreen = element;
  await act(async () => { document.dispatchEvent(new Event("fullscreenchange")); });
}

const popup = () => document.querySelector<HTMLElement>('.pop-panel[aria-label="Playback options"]');

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  fullscreen = null;
  originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  if (originalFullscreen) Object.defineProperty(document, "fullscreenElement", originalFullscreen);
  else Reflect.deleteProperty(document, "fullscreenElement");
});

describe("Popover portals remain inside native fullscreen", () => {
  it("moves an open popup from body into the fullscreen subtree and back on exit", async () => {
    await render();
    const main = container.querySelector<HTMLElement>(".main")!;
    expect(popup()).not.toBeNull();
    expect(document.body.contains(popup())).toBe(true);
    expect(main.contains(popup())).toBe(false);

    await changeFullscreen(main);
    expect(popup()).not.toBeNull();
    expect(main.contains(popup())).toBe(true);
    const speed = popup()!.querySelector<HTMLSelectElement>('select[aria-label="Study playback speed"]')!;
    await act(async () => { speed.focus(); });
    expect(document.activeElement).toBe(speed);

    await changeFullscreen(null);
    expect(popup()).not.toBeNull();
    expect(document.body.contains(popup())).toBe(true);
    expect(main.contains(popup())).toBe(false);
  });

  it("opens into an already-fullscreen subtree rather than the hidden body", async () => {
    await render(false);
    const main = container.querySelector<HTMLElement>(".main")!;
    await changeFullscreen(main);
    await render(true);
    expect(popup()).not.toBeNull();
    expect(main.contains(popup())).toBe(true);
  });
});
