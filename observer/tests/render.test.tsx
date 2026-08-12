// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import firstRun from "../../tests/golden/observer-data/first-run.json";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";

// The golden is schema-proven at the repo root (tests/observer-data-contract.test.ts);
// rendering it here proves the scaffold consumes the frozen contract as-is.
const data = firstRun as unknown as ObserverData;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no matchMedia; the register contract (lib/humanish/theme.ts) reads it.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
});

async function mount(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("observer scaffold rendering the first-run golden", () => {
  it("renders the study grid: tally line + one card per participant", async () => {
    await mount(<App data={data} />);
    expect(container.querySelectorAll(".card")).toHaveLength(4);
    const tally = container.querySelector(".countline")?.textContent ?? "";
    expect(tally).toContain("4 lanes");
    expect(tally).toContain("4 warnings");
    expect(tally).toContain("dry-run");
    // every card carries exactly one signal line
    expect(container.querySelectorAll(".card .plab")).toHaveLength(4);
  });

  it("register toggle writes data-theme and persists the explicit choice", async () => {
    await mount(<App data={data} />);
    const toggle = container.querySelector('button[aria-label="Toggle color register"]');
    expect(toggle).not.toBeNull();
    await click(toggle as Element);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("humanish-theme")).toBe("dark");
    await click(toggle as Element);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens a participant from its card and returns on Escape", async () => {
    await mount(<App data={data} />);
    const overlay = container.querySelector(".open-overlay");
    expect(overlay).not.toBeNull();
    await click(overlay as Element);
    expect(container.textContent).toContain("Review player");
    expect(container.querySelector(".pager")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelectorAll(".card")).toHaveLength(4);
  });

  it("renders the honest empty state when no data is inlined", async () => {
    await mount(<App data={null} />);
    expect(container.textContent).toContain("opened without run data");
  });
});

// A live-shaped stream, grafted onto the frozen golden IN THE TEST (the committed
// goldens stay dry-run; a live-shaped golden lands with the contract-addition PR).
// Shapes mirror humanish.actor-trace.v1 as produced by the computer-use route.
function liveShapedData(): ObserverData {
  const clone = structuredClone(firstRun) as unknown as { streams: Array<Record<string, unknown>> };
  const stream = clone.streams[0];
  if (!stream) throw new Error("fixture has no stream");
  stream.timeline = []; // dry-run warn events would outrank the notable completion below
  stream.actor = {
    provider: "computer-use-loop",
    durationMs: 191_864,
    status: "passed",
    completionReason: "budget_reached",
    reason: "estimated spend $5.14 crossed execution.caps.maxUsd=$5 after productive activity",
    ids: { model: "synthetic-model" },
    items: [
      {
        id: "screenshot-001",
        kind: "screenshot",
        lifecycle: "completed",
        title: "turn-00-start",
        screenshotRef: { path: "screenshots/lane/turn-00-start.png", redaction: "none" }
      },
      { id: "ui_action-001", kind: "ui_action", lifecycle: "completed", title: "keypress TAB" },
      {
        id: "screenshot-002",
        kind: "screenshot",
        lifecycle: "completed",
        title: "turn-01",
        screenshotRef: { path: "screenshots/lane/turn-01.png", redaction: "none" }
      }
    ],
    affordanceUse: {
      schema: "humanish.affordance-use.v1",
      counts: { keyboard: 2, pointer: 1 },
      total: 3,
      shortcutTotal: 0
    }
  };
  return clone as unknown as ObserverData;
}

describe("observer scaffold rendering a live-shaped lane", () => {
  it("shows the keyframe thumb (last screenshot) and the ⚑ notable reason verbatim", async () => {
    await mount(<App data={liveShapedData()} />);
    const img = container.querySelector(".card .keyframe");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("../screenshots/lane/turn-01.png");
    const card = container.querySelector(".card");
    expect(card?.textContent).toContain("budget cap");
    expect(card?.textContent).toContain("crossed execution.caps.maxUsd=$5");
  });
});
