// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

  it("reads no run from a page whose items are unreadable, rather than participants with no steps", async () => {
    const data = await live();
    const filled = injectObserverData(SLOT, data).replace(
      /(<script id="observer-items"[^>]*>)[^<]*/,
      "$1bm90IGd6aXA=",
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
    const body = JSON.parse(feed(data)) as { data: unknown; items: { runId: string } };
    for (const items of [
      { ...body.items, runId: "another-run" },
      { ...body.items, streams: {} },
    ]) {
      const served = (async () => ({
        ok: true,
        json: async () => ({ data: body.data, items }),
      })) as unknown as typeof fetch;
      expect(await fetchObserverData(served)).toBeNull();
    }
  });
});
