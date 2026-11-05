// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PointerCursor, usePointerView, type PointerView } from "../components/pointer-cursor";
import type { PlayerModel } from "../lib/player-model";
import type { PlayerPlayback } from "../lib/use-player-playback";
import type { StudyPlayerControl } from "../lib/use-study-playback";
import type { FramePointer } from "../lib/pointer-track";

const frame: FramePointer = {
  rest: { x: 200, y: 100 },
  pressesOnly: false,
  touch: false,
  moves: [
    {
      rowId: "click-1",
      label: "click-1",
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
      frame: { rest: null, moves: [], pressesOnly: false, touch: false },
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

describe("what the drawn pointer shows beside the arrow", () => {
  it("names the action it last finished while paused, and nothing while playing", async () => {
    const paused = await render({ ageMs: 4_500 });
    const caption = () => paused.arrow.querySelector(".pointer-caption")!;
    expect([paused.arrow.hasAttribute("data-captioned"), caption().textContent]).toEqual([
      true,
      "click-1",
    ]);
    expect(paused.arrow.hasAttribute("data-caption-left")).toBe(true);
    expect(paused.arrow.hasAttribute("data-caption-above")).toBe(true);
    await paused.cleanup();
    const before = await render({ ageMs: 1_000 });
    expect(before.arrow.hasAttribute("data-captioned")).toBe(false);
    await before.cleanup();
    const playing = await render({ ageMs: 4_500, playing: true, limitMs: 4_500 });
    expect(playing.arrow.hasAttribute("data-captioned")).toBe(false);
    await playing.cleanup();
  });

  it("draws a fingertip on a touch screen, only around a press", async () => {
    const touch: FramePointer = {
      rest: null,
      pressesOnly: false,
      touch: true,
      moves: [{ ...frame.moves[0]!, startMs: 4_400 }],
    };
    const away = await render({ frame: touch, ageMs: 1_000 });
    expect(away.arrow.getAttribute("data-input")).toBe("touch");
    expect(away.arrow.querySelector(".pointer-touch")).not.toBeNull();
    expect(away.arrow.querySelector(".pointer-arrow")).toBeNull();
    expect(away.arrow.hasAttribute("data-placed")).toBe(false);
    await away.cleanup();
    const tapped = await render({ frame: touch, ageMs: 4_450 });
    expect([tapped.arrow.hasAttribute("data-placed"), tapped.arrow.style.left]).toEqual([
      true,
      "80%",
    ]);
    await tapped.cleanup();
  });
});

describe("the pointer view on a selected entry", () => {
  it("puts a paused pointer where the selected action ended under the study clock too", async () => {
    const tap = {
      id: "tap",
      kind: "ui_action",
      title: "click (400, 300)",
      frameIndex: 0,
      isFrame: false,
      atMs: 14_000,
      coord: { x: 400, y: 300 },
      pointerPath: [{ x: 400, y: 300 }],
    };
    const model: PlayerModel = {
      frames: [
        { index: 0, itemId: "turn-0", title: "turn-0", href: "a.png", atMs: 10_000 },
        { index: 1, itemId: "turn-1", title: "turn-1", href: "b.png", atMs: 20_000 },
      ],
      rows: [tap],
      avgFrameMs: 10_000,
      paced: "recorded",
      touch: true,
    };
    const playback = {
      frame: 0,
      live: null,
      playing: false,
      selectedRow: tap,
    } as unknown as PlayerPlayback;
    const clock = {
      moment: { kind: "capture", ageMs: 0 },
      playing: false,
      speed: 1,
    } as unknown as StudyPlayerControl;
    let seen: PointerView | null = null;
    function Probe() {
      seen = usePointerView(model, "p1", playback, clock, 1, true);
      return null;
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    expect(seen).toMatchObject({ ageMs: 4_000, playing: false });
    await act(async () => root.unmount());
  });
});
