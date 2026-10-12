// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observerDataFromFeed } from "../lib/data";
import type { ObserverData } from "../lib/observer-data";
import { useObserverFeed } from "../lib/use-observer-feed";

// A served page polls observer-feed.json and sends back the live cursors of the last body it
// joined; a body then carries only each running participant's items past its cursor. The bodies
// are the ones the real server answered over one run (tests/observer/feed-cursor.test.ts writes
// tests/golden/observer-feed/sequence.json): a full body, tails, a new generation, the finished run.
interface FeedEntry {
  live?: string;
  liveAfter?: string;
  liveActor?: unknown[];
}
interface FeedBody {
  data: unknown;
  items: { runId: string; streams: Record<string, FeedEntry> };
}
const sequence = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../tests/golden/observer-feed/sequence.json"),
    "utf8",
  ),
) as { after: string | null; body: FeedBody }[];
const body = (index: number): FeedBody => structuredClone(sequence[index]!.body);

let container: HTMLDivElement, root: Root;
/** The bodies the next feed polls get, in order; null answers 404. The last one repeats. */
let answers: (FeedBody | null)[];
/** The `after` parameter of each feed poll, null when it sent none. */
let sent: (string | null)[];

function Probe({ initial }: { initial: ObserverData }) {
  const { data, connection } = useObserverFeed(initial);
  return (
    <pre data-state={connection.state}>
      {JSON.stringify(
        data?.streams.map((stream) => stream.liveActor?.items.map((item) => item.id) ?? null),
      )}
    </pre>
  );
}

const shown = () => JSON.parse(container.querySelector("pre")!.textContent!) as unknown;
const state = () => container.querySelector("pre")!.getAttribute("data-state");
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime("2026-10-12T23:00:00.000Z");
  sent = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, "fetch").mockImplementation(async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, "http://localhost/observer/");
    if (url.pathname !== "/observer/observer-feed.json") return new Response(null, { status: 404 });
    sent.push(url.searchParams.get("after"));
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return next === null ? new Response(null, { status: 404 }) : new Response(JSON.stringify(next));
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mount the page on the first body's data, as its inline snapshot gives it, and let it poll once. */
async function mount() {
  const initial = observerDataFromFeed(body(0))!;
  expect(initial).not.toBeNull();
  await act(async () => {
    root.render(<Probe initial={initial} />);
  });
  await advance(0);
}

describe("the page's live feed", () => {
  it("sends back each body's cursors and shows every item the run's live files hold", async () => {
    answers = [body(0), body(1), body(2), body(3)];
    await mount();
    expect(shown()).toEqual([["reasoning-001", "reasoning-002"], ["reasoning-003"]]);
    await advance(5000);
    expect(shown()).toEqual([
      ["reasoning-001", "reasoning-002", "reasoning-004"],
      ["reasoning-003"],
    ]);
    await advance(5000);
    expect(shown()).toEqual([
      ["reasoning-001", "reasoning-002", "reasoning-004", "reasoning-005"],
      ["reasoning-003", "reasoning-006"],
    ]);
    await advance(5000);
    expect(shown()).toEqual([null]);
    await advance(5000);
    expect(sent).toEqual([
      null,
      "1.1.2.308,2.1.1.154",
      "1.1.3.462,2.1.1.154",
      "1.2.4.616,2.1.2.308",
      null,
    ]);
    // The server answered exactly these requests when the bodies were captured.
    expect(sent.slice(0, 4)).toEqual(sequence.map((entry) => entry.after));
  });

  it("sends no cursors after a body from a server that gives none", async () => {
    const older = body(0);
    for (const entry of Object.values(older.items.streams)) delete entry.live;
    answers = [older, body(0)];
    await mount();
    await advance(5000);
    expect(sent).toEqual([null, null]);
  });

  it("keeps its cursors through a poll the server answers with an error", async () => {
    answers = [body(0), null, body(1)];
    await mount();
    await advance(5000);
    expect(state()).toBe("retrying");
    await advance(5000);
    expect(sent).toEqual([null, "1.1.2.308,2.1.1.154", "1.1.2.308,2.1.1.154"]);
    expect(shown()).toEqual([
      ["reasoning-001", "reasoning-002", "reasoning-004"],
      ["reasoning-003"],
    ]);
  });

  it("refuses a tail that follows a cursor it does not hold, and asks for every list next", async () => {
    const stray = body(1);
    stray.items.streams["sim-01-ui"]!.liveAfter = "1.1.1.154";
    answers = [body(0), stray, body(0)];
    await mount();
    await advance(5000);
    expect(state()).toBe("retrying");
    expect(shown()).toEqual([["reasoning-001", "reasoning-002"], ["reasoning-003"]]);
    await advance(5000);
    expect(sent).toEqual([null, "1.1.2.308,2.1.1.154", null]);
    expect(state()).toBe("current");
  });
});
