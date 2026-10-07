// @vitest-environment jsdom
// Reviewer notes in the Observer: "Add a note at 00:04" while the study timeline is paused, a
// marker per note on that timeline, and a "Reviewer notes" list beside the findings.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { App } from "../app";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import type { RunNote, RunNotesState } from "../lib/run-notes";

const feed = vi.hoisted(() => ({ data: null as ObserverData | null }));
vi.mock("../lib/use-observer-feed", async () => {
  const { NO_ANALYSIS } = await import("../lib/study-analysis");
  return {
    useObserverFeed: () => ({
      data: feed.data,
      analysis: NO_ANALYSIS,
      history: null,
      connection: { state: "offline", lastReceivedAt: 0 },
      retry: () => undefined,
    }),
  };
});

const origin = Date.parse("2026-09-01T10:00:00.000Z");
const TOKEN = "t".repeat(43);
let container: HTMLDivElement;
let root: Root;

function lane(id: string, offsets: number[]): ObserverStream {
  const stream = structuredClone((live as unknown as ObserverData).streams[0]!);
  stream.id = id;
  stream.actor!.items = offsets.map((offset, index) => ({
    id: `${id}-${index}`,
    kind: "screenshot",
    lifecycle: "completed",
    title: `Capture ${index}`,
    at: new Date(origin + offset).toISOString(),
    screenshotRef: { path: `screenshots/${id}-${index}.png`, redaction: "none" },
  }));
  return stream;
}

function study(): ObserverData {
  const data = structuredClone(live) as unknown as ObserverData;
  data.streams = [lane("early", [0, 3000, 9000]), lane("late", [1000, 6000])];
  return data;
}

function note(atMs: number, participant: string | null, text: string): RunNote {
  return {
    id: `note-${atMs}`,
    atMs,
    participant,
    nearest: null,
    text,
    author: "you",
    createdAt: "2026-09-01T11:00:00.000Z",
    editedAt: null,
  };
}

async function render(notes: RunNotesState, snapshot = false) {
  const data = study();
  feed.data = data;
  await act(async () => root.render(<App data={data} snapshot={snapshot} notes={notes} />));
  return data;
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}
const scrub = () =>
  container.querySelector<HTMLInputElement>('[aria-label="Seek study recording"]')!;
async function seek(value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      scrub(),
      String(value),
    );
    scrub().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const addButton = () => document.querySelector('button[aria-label^="Add a note at"]');
async function type(text: string) {
  const area = document.querySelector<HTMLTextAreaElement>("textarea[name=note]");
  expect(area).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
      area,
      text,
    );
    area!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

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
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("adding a reviewer note", () => {
  it("offers Add a note at the paused study time and saves it for the whole study", async () => {
    const saved = note(4500, null, "Both participants stalled here.");
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            note: saved,
            notes: { schema: "humanish.run-notes.v1", runId: study().run.runId, notes: [saved] },
            scrubbed: false,
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const data = await render({ notes: [], token: TOKEN, unreadable: false });
    await seek(4500);

    await click(addButton());
    expect(addButton()?.getAttribute("aria-label")).toBe("Add a note at 00:04");
    await type("Both participants stalled here.");
    await click(document.querySelector("form.note-form button[type=submit]"));

    expect(fetch).toHaveBeenCalledWith("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-humanish-notes-token": TOKEN },
      body: JSON.stringify({
        runId: data.run.runId,
        atMs: 4500,
        participant: null,
        text: "Both participants stalled here.",
      }),
    });
    expect(container.querySelectorAll(".study-playback .scrub-note")).toHaveLength(1);
    expect(document.body.textContent).toContain("Note saved at 00:04.");
  });

  it("gives the note the open participant", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    await render({ notes: [], token: TOKEN, unreadable: false });
    await seek(3000);
    await click(container.querySelector('[data-stream-id="early"] .open-overlay'));

    await click(addButton());
    await type("Early stalls.");
    await click(document.querySelector("form.note-form button[type=submit]"));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ atMs: 3000, participant: "early" });
    expect(document.body.textContent).toContain("The note was not saved");
  });

  it("offers no way to add a note while playing, before a moment is chosen, or without a token", async () => {
    await render({ notes: [], token: TOKEN, unreadable: false });
    expect(addButton()).toBeNull();
    await seek(4500);
    await click(container.querySelector('[aria-label="Play study"]'));
    expect(addButton()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);

    await render({ notes: [], token: null, unreadable: false });
    await seek(4500);
    expect(addButton()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);

    await render({ notes: [], token: TOKEN, unreadable: false }, true);
    await seek(4500);
    expect(addButton()).toBeNull();
  });
});

describe("reading reviewer notes", () => {
  it("marks each note on the study timeline and lists them, marked human, beside the findings", async () => {
    await render({
      notes: [note(6000, "late", "They gave up."), note(1000, null, "Slow start.")],
      token: null,
      unreadable: false,
    });

    const markers = [...container.querySelectorAll<HTMLElement>(".study-playback .scrub-note")];
    const positions = markers.map((marker) => Number.parseFloat(marker.style.left));
    expect(positions).toHaveLength(2);
    expect(positions[0]).toBeCloseTo(100 / 9);
    expect(positions[1]).toBeCloseTo(200 / 3);
    await click(container.querySelector('a[href="#/report"]'));

    const list = container.querySelector('section[aria-labelledby="reviewer-notes-heading"]');
    expect(list?.querySelector("h2")?.textContent).toContain("Reviewer notes");
    expect([...(list?.querySelectorAll("li") ?? [])].map((item) => item.textContent)).toEqual([
      expect.stringMatching(/00:01.*Whole study.*Human.*you.*Slow start\./),
      expect.stringMatching(/00:06.*· late.*Human.*you.*They gave up\./),
    ]);
  });

  it("opens a note at its moment on the study timeline", async () => {
    await render({ notes: [note(6000, "late", "They gave up.")], token: null, unreadable: false });
    await click(container.querySelector('a[href="#/report"]'));

    await click(container.querySelector('[data-note="note-6000"] button'));

    expect(scrub().value).toBe("6000");
    expect(window.location.hash).toContain("late");
  });
});
