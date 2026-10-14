// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ObserverData } from "../../src/observer/data";
import { readInlineObserverData } from "../lib/data";
import { fetchObserverData } from "../lib/live";
import { OBSERVER_DATA_PLACEHOLDER, injectObserverData } from "../scripts/inject";
import { feed } from "./feed";

// The pinned live snapshot: participants with screenshots, reasoning and click items.
const live = async (): Promise<ObserverData> =>
  JSON.parse(
    await readFile(
      path.join(import.meta.dirname, "..", "..", "tests", "golden", "observer-data", "live.json"),
      "utf8",
    ),
  ) as ObserverData;

const page = (body: string): Document =>
  new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, "text/html");
const SLOT = `<script id="observer-data" type="application/json">${OBSERVER_DATA_PLACEHOLDER}</script>`;

describe("the page's run data", () => {
  it("reads the run with every participant's items from a page the CLI filled", async () => {
    const data = await live();
    const doc = page(injectObserverData(SLOT, data));
    expect(await readInlineObserverData(doc)).toEqual(data);
  });

  it("decodes each participant's items on its own, so no string holds two participants' items", async () => {
    const data = await twoParticipants();
    const doc = page(injectObserverData(SLOT, data));
    const parse = vi.spyOn(JSON, "parse");
    const read = await readInlineObserverData(doc);
    const parsed = parse.mock.calls.map(([text]) => String(text));
    parse.mockRestore();
    expect(read).toEqual(data);
    expect(
      parsed.filter((text) => text.includes('"id":"one-') && text.includes('"id":"two-')),
    ).toEqual([]);
  });

  it("reads no run from a page whose items are unreadable, rather than participants with no steps", async () => {
    const data = await live();
    const filled = injectObserverData(SLOT, data).replace(
      /(<script id="observer-items"[^>]*>)[^<]*/,
      `$1${JSON.stringify({ schema: "humanish.observer-items.v2", runId: data.run.runId, streams: [[data.streams[0]!.id, "bm90IGd6aXA="]] })}`,
    );
    expect(await readInlineObserverData(page(filled))).toBeNull();
    const missing = injectObserverData(SLOT, data).replace(
      /<script id="observer-items"[^>]*>[^<]*<\/script>/,
      "",
    );
    expect(await readInlineObserverData(page(missing))).toBeNull();
  });

  it("reads a served run's data and items from its feed", async () => {
    const data = await live();
    let asked = "";
    const served = (async (url: string) => {
      asked = url;
      return { ok: true, json: async () => JSON.parse(feed(data)) as unknown };
    }) as unknown as typeof fetch;
    expect(await fetchObserverData(served)).toEqual(data);
    expect(asked).toBe("observer-feed.json");
  });

  it("refuses a feed whose items are another run's or leave a participant out", async () => {
    const data = await live();
    const body = JSON.parse(feed(data)) as {
      data: unknown;
      items: { runId: string; streams: [string, string][] };
    };
    const [[id, packed]] = body.items.streams as [[string, string]];
    for (const items of [
      { ...body.items, runId: "another-run" },
      { ...body.items, streams: [] },
      // Entries as a page before per-participant packing carried them.
      { ...body.items, streams: { [id]: { actor: [] } } },
      { ...body.items, streams: { [id]: packed } },
    ]) {
      const served = (async () => ({
        ok: true,
        json: async () => ({ data: body.data, items }),
      })) as unknown as typeof fetch;
      expect(await fetchObserverData(served)).toBeNull();
    }
  });
});

/** The live run with a second participant, each participant's item ids marked as its own. */
async function twoParticipants(): Promise<ObserverData> {
  const data = await live();
  const [stream] = data.streams;
  const marked = (id: string, prefix: string) => ({
    ...stream!,
    id,
    actor: {
      ...stream!.actor!,
      items: stream!.actor!.items.map((item) => ({ ...item, id: `${prefix}-${item.id}` })),
    },
  });
  return { ...data, streams: [marked("stream-001", "one"), marked("stream-002", "two")] };
}
