// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { PlayerStage } from "../components/player-stage";

const frame = { index: 0, itemId: "captured-phone", title: "Synthetic phone capture", href: "../screenshots/phone.png" };

describe("live screenshot geometry", () => {
  it.each([undefined, { width: 1280, height: 800 }])("learns portrait proportions with fallback %j, keeps them during loads, and cleans up", async (viewport) => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const images: HTMLImageElement[] = [];
    const OriginalImage = globalThis.Image;
    class ObservedImage extends OriginalImage {
      constructor() { super(); images.push(this); }
    }
    vi.stubGlobal("Image", ObservedImage);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async (next = frame) => act(async () => root.render(<PlayerStage frame={next} count={1} viewport={viewport}
      pins={[]} zoom="fit" live="https://live.example/desktop" label="Synthetic phone" emptyText="No captures" />));
    try {
      await render();
      if (!viewport) expect(container.textContent).toContain("provisional");
      const image = images[0]!;
      Object.defineProperty(image, "naturalWidth", { value: 500 });
      Object.defineProperty(image, "naturalHeight", { value: 896 });
      await act(async () => image.dispatchEvent(new Event("load")));
      const stage = container.querySelector<HTMLElement>(".stage-live")!;
      expect(Number.parseFloat(stage.style.width) / Number.parseFloat(stage.style.height)).toBeCloseTo(500 / 896);
      expect(container.textContent).not.toContain("provisional");
      await render({ ...frame, href: "../screenshots/next.png" });
      expect(image.onload).toBeNull();
      expect(Number.parseFloat(stage.style.width) / Number.parseFloat(stage.style.height)).toBeCloseTo(500 / 896);
      const pending = images[1]!;
      await act(async () => pending.dispatchEvent(new Event("error")));
      expect(Number.parseFloat(stage.style.width) / Number.parseFloat(stage.style.height)).toBeCloseTo(500 / 896);
      await act(async () => root.unmount());
      expect(pending.onload).toBeNull();
    } finally {
      if (container.childNodes.length) await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
