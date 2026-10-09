// @vitest-environment jsdom
// The participant grid of a 40- and a 100-participant run, through the rendered App: the status
// row, the persona filter, paging, pins and comparison.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import firstRun from "../../tests/golden/observer-data/first-run.json";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";
import { scaleFixture } from "./scale-fixture";

let container: HTMLDivElement;
let root: Root;

async function mount(data: ObserverData): Promise<void> {
  await act(async () => root.render(<App data={data} snapshot />));
}
function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(match, text).toBeDefined();
  return match!;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}
async function choose(label: string, value: string): Promise<void> {
  await click(find(`[aria-label="View and filter participants"]`));
  await click(find(`[role="combobox"][aria-label="${label}"]`));
  const option = find(`.observer-select-option[data-value="${value}"]`);
  await act(async () => {
    const pointer = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointer, "pointerType", { value: "touch" });
    option.dispatchEvent(pointer);
    option.click();
  });
  await click(find('[aria-label="Close view options"]'));
}
const cards = () => [...document.querySelectorAll<HTMLElement>(".gallery .card")];
const pages = () => document.querySelector(".grid-pages span")?.textContent ?? null;
const statusRow = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".grid-status button")].map((status) => [
    status.textContent,
    status.getAttribute("aria-pressed"),
  ]);

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

describe.each([
  { count: 40, complete: 24, each: 4, keyboardFirst: 13, lastPage: "Showing 37–40 of 40" },
  { count: 100, complete: 60, each: 10, keyboardFirst: 33, lastPage: "Showing 73–100 of 100" },
])("a run of $count participants", ({ count, complete, each, keyboardFirst, lastPage }) => {
  it("counts the participants by status above the grid, and a count filters the grid to them", async () => {
    await mount(scaleFixture(count));
    expect(statusRow()).toEqual([
      [`Reported complete ${complete}`, "false"],
      [`Blocked ${each}`, "false"],
      [`Gave up ${each}`, "false"],
      [`Interrupted ${each}`, "false"],
      [`Failed ${each}`, "false"],
    ]);
    await click(button(`Blocked ${each}`));
    // Every tenth participant from the seventh is blocked.
    expect(cards().map((card) => card.dataset.streamId)).toEqual(
      Array.from({ length: each }, (_, tens) => `stream-0${tens}7`),
    );
    expect(statusRow()[1]).toEqual([`Blocked ${each}`, "true"]);
    expect(pages()).toBeNull();
    await click(button(`Blocked ${each}`));
    expect(cards()).toHaveLength(36);
    expect(pages()).toBe(`Showing 1–36 of ${count} participants`);
  });

  it("filters the grid to one persona", async () => {
    await mount(scaleFixture(count));
    await choose("Participant persona", "keyboard-first");
    expect(cards()).toHaveLength(keyboardFirst);
    expect(find(".filter-count").textContent).toBe("1");
    await click(find(`[aria-label="View and filter participants"]`));
    await click(button("Clear filters"));
    expect(cards()).toHaveLength(36);
  });

  it("pages through every participant and starts again at page 1 after a filter changes", async () => {
    await mount(scaleFixture(count));
    expect(pages()).toBe(`Showing 1–36 of ${count} participants`);
    while (!button("Next page").disabled) await click(button("Next page"));
    expect(pages()).toBe(`${lastPage} participants`);
    expect(cards()).toHaveLength(count === 40 ? 4 : 28);
    await click(button(`Failed ${each}`));
    await click(button(`Failed ${each}`));
    expect(pages()).toBe(`Showing 1–36 of ${count} participants`);
  });

  it("pins a participant from the last page to the top of page 1", async () => {
    await mount(scaleFixture(count));
    while (!button("Next page").disabled) await click(button("Next page"));
    const last = cards().at(-1)!;
    const id = last.dataset.streamId;
    await click(find(`[data-stream-id="${id}"] .card-pin-toggle`));
    while (!button("Previous page").disabled) await click(button("Previous page"));
    expect(cards()[0]!.dataset.streamId).toBe(id);
  });

  it("compares three participants", async () => {
    await mount(scaleFixture(count));
    for (const card of cards().slice(0, 3)) {
      await click(find(`[data-stream-id="${card.dataset.streamId}"] .card-details-trigger`));
      await click(find('.pop-panel button[aria-label^="Compare participant"]'));
      await click(find('.pop-panel [aria-label="Close participant details"]'));
    }
    await click(button("Compare selected (3/3)"));
    expect(document.querySelectorAll(".compare-participant")).toHaveLength(3);
  });
});

describe("filters saved by an earlier release", () => {
  it("keep a status filter saved before the persona filter existed", async () => {
    localStorage.setItem(
      "humanish-observer-filters",
      JSON.stringify({ status: "Failed", kind: "", query: "" }),
    );
    await mount(scaleFixture(40));
    expect(cards()).toHaveLength(4);
    expect(statusRow()[4]).toEqual(["Failed 4", "true"]);
  });
});

describe("a run whose participants share one status and one persona", () => {
  it("shows no status row and no persona filter", async () => {
    await mount(firstRun as unknown as ObserverData);
    expect(document.querySelector(".grid-status")).toBeNull();
    await click(find(`[aria-label="View and filter participants"]`));
    expect(document.querySelector('[aria-label="Participant status"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Participant persona"]')).toBeNull();
  });
});
