// @vitest-environment jsdom
// Characterization of the evidence stage through the rendered component: keys and drag on a
// zoomed recording, and which proportions size the live view.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerStage } from "../components/player-stage";

const frame = {
  index: 0,
  itemId: "captured-desktop",
  title: "Synthetic desktop capture",
  href: "../screenshots/desktop.png",
};
let container: HTMLDivElement;
let root: Root;

async function render(props: Partial<ComponentProps<typeof PlayerStage>> = {}): Promise<void> {
  await act(async () =>
    root.render(
      <PlayerStage
        frame={frame}
        count={1}
        viewport={{ width: 1280, height: 800 }}
        pins={[]}
        zoom={2}
        live={null}
        label="Synthetic participant"
        emptyText="No captures"
        {...props}
      />,
    ),
  );
}
const stage = () => container.querySelector<HTMLElement>(".evidence-stage")!;
async function key(value: string): Promise<void> {
  await act(async () =>
    stage().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })),
  );
}
async function pointer(type: string, init: MouseEventInit, pointerType = "mouse"): Promise<void> {
  const event = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => stage().dispatchEvent(event));
}
const ratio = () => {
  const live = container.querySelector<HTMLElement>(".stage-live")!;
  return Number.parseFloat(live.style.width) / Number.parseFloat(live.style.height);
};

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no pointer capture; the stage only asks for it.
  Element.prototype.setPointerCapture ??= () => undefined;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a zoomed recording", () => {
  it("keeps arrow, paging and space keys inside the focused stage", async () => {
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    try {
      await render();
      expect(stage().getAttribute("aria-label")).toBe("Zoomed evidence; scroll or drag to pan");
      expect(stage().tabIndex).toBe(0);
      for (const name of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) await key(name);
      for (const name of ["PageUp", "PageDown", "Home", "End", " "]) await key(name);
      await key("f");
      expect(seen).toEqual(["f"]);
      await render({ zoom: "fit" });
      expect(stage().getAttribute("aria-label")).toBe("Evidence stage");
      await key("ArrowLeft");
      await render({ zoom: "actual", live: "https://live.example/desktop" });
      expect(stage().tabIndex).toBe(-1);
      await key("ArrowRight");
      expect(seen).toEqual(["f", "ArrowLeft", "ArrowRight"]);
    } finally {
      window.removeEventListener("keydown", listen);
    }
  });

  it("pans with a mouse drag, and only while zoomed with the primary button", async () => {
    await render();
    await pointer("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    await pointer("pointermove", { clientX: 60, clientY: 70 });
    expect([stage().scrollLeft, stage().scrollTop]).toEqual([40, 30]);
    await pointer("pointerup", {});
    await pointer("pointermove", { clientX: 0, clientY: 0 });
    expect([stage().scrollLeft, stage().scrollTop]).toEqual([40, 30]);

    await pointer("pointerdown", { clientX: 100, clientY: 100, button: 2 });
    await pointer("pointermove", { clientX: 90, clientY: 90 });
    await pointer("pointerdown", { clientX: 100, clientY: 100, button: 0 }, "touch");
    await pointer("pointermove", { clientX: 90, clientY: 90 });
    expect([stage().scrollLeft, stage().scrollTop]).toEqual([40, 30]);

    await pointer("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    await act(async () =>
      stage().dispatchEvent(new Event("lostpointercapture", { bubbles: true })),
    );
    await pointer("pointermove", { clientX: 90, clientY: 90 });
    expect([stage().scrollLeft, stage().scrollTop]).toEqual([40, 30]);

    await render({ zoom: "fit" });
    await pointer("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    await pointer("pointermove", { clientX: 90, clientY: 90 });
    expect([stage().scrollLeft, stage().scrollTop]).toEqual([40, 30]);
  });
});

describe("the live view's proportions", () => {
  it("uses its own measured capture when a new label and the live view arrive together", async () => {
    // A capture the browser already holds: measured as soon as the stage asks for it.
    const OriginalImage = globalThis.Image;
    vi.stubGlobal(
      "Image",
      class HeldImage {
        constructor() {
          const image = new OriginalImage();
          Object.defineProperty(image, "complete", { value: true });
          Object.defineProperty(image, "naturalWidth", { value: 500 });
          Object.defineProperty(image, "naturalHeight", { value: 896 });
          return image;
        }
      },
    );
    await render({ zoom: "fit", label: "First label" });
    const recorded = container.querySelector<HTMLImageElement>(".stage-box img")!;
    Object.defineProperty(recorded, "naturalWidth", { value: 1600 });
    Object.defineProperty(recorded, "naturalHeight", { value: 900 });
    await act(async () => recorded.dispatchEvent(new Event("load")));
    expect(container.querySelector(".evidence-image")?.getAttribute("data-image-state")).toBe(
      "ready",
    );
    await render({ zoom: "fit", label: "Second label", live: "https://live.example/desktop" });
    expect(ratio()).toBeCloseTo(500 / 896);
  });

  it("keeps the last recorded proportions for a live view until its capture is measured", async () => {
    await render({ zoom: "fit", viewport: undefined });
    const recorded = container.querySelector<HTMLImageElement>(".stage-box img")!;
    Object.defineProperty(recorded, "naturalWidth", { value: 1600 });
    Object.defineProperty(recorded, "naturalHeight", { value: 900 });
    await act(async () => recorded.dispatchEvent(new Event("load")));
    await render({
      zoom: "fit",
      viewport: undefined,
      frame: undefined,
      live: "https://live.example/desktop",
    });
    expect(ratio()).toBeCloseTo(1600 / 900);
    expect(container.textContent).not.toContain("provisional");
    await render({
      zoom: "fit",
      viewport: undefined,
      frame: undefined,
      live: "https://live.example/desktop",
      label: "Another participant",
    });
    expect(ratio()).toBeCloseTo(1280 / 800);
    expect(container.textContent).toContain(
      "Preview proportions are provisional until a captured screen is available.",
    );
  });
});
