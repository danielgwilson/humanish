// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PointerCursor, type PointerView } from "../components/pointer-cursor";
import type { FramePointer } from "../lib/pointer-track";

const frame: FramePointer = {
  rest: { x: 200, y: 100 },
  pressesOnly: false,
  moves: [
    {
      rowId: "click-1",
      startMs: 4_000,
      endMs: 4_400,
      press: true,
      position: (fraction) => ({ x: 200 + 600 * fraction, y: 100 + 300 * fraction }),
    },
  ],
};

async function render(view: Partial<PointerView>) {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <PointerCursor
        view={{
          frame,
          ageMs: 0,
          playing: false,
          speed: 1,
          limitMs: 10_000,
          anchor: "a",
          ...view,
        }}
        viewport={{ width: 1000, height: 500 }}
      />,
    ),
  );
  const arrow = container.querySelector<HTMLElement>("[data-testid=pointer-cursor]")!;
  const ring = arrow.querySelector<HTMLElement>(".pointer-ring")!;
  return { arrow, ring, cleanup: () => act(async () => root.unmount()) };
}

describe("the drawn pointer", () => {
  it("rests where the capture shows the pointer, in the frame's percentage box", async () => {
    const { arrow, ring, cleanup } = await render({ ageMs: 0 });
    expect([arrow.hasAttribute("data-placed"), arrow.style.left, arrow.style.top]).toEqual([
      true,
      "20%",
      "20%",
    ]);
    expect(ring.style.opacity).toBe("0");
    await cleanup();
  });

  it("lands on the press and rings just after it", async () => {
    const { arrow, ring, cleanup } = await render({ ageMs: 4_500 });
    expect([arrow.style.left, arrow.style.top]).toEqual(["80%", "80%"]);
    expect(Number(ring.style.opacity)).toBeGreaterThan(0);
    await cleanup();
  });

  it("is hidden before any recorded position", async () => {
    const { arrow, cleanup } = await render({
      frame: { rest: null, moves: [], pressesOnly: false },
    });
    expect(arrow.hasAttribute("data-placed")).toBe(false);
    await cleanup();
  });

  it("never draws past the capture interval", async () => {
    const { arrow, cleanup } = await render({ ageMs: 4_200, limitMs: 4_000 });
    expect([arrow.style.left, arrow.style.top]).toEqual(["20%", "20%"]);
    await cleanup();
  });
});
