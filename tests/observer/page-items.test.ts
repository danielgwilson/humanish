import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { renderObserverHtml } from "../../src/observer/artifact.js";
import { withObserverEndings, type ObserverData } from "../../src/observer/data.js";
import { readObserverPage } from "../helpers/observer-page.js";

const live = async (): Promise<ObserverData> =>
  JSON.parse(
    await readFile(
      path.join(process.cwd(), "tests", "golden", "observer-data", "live.json"),
      "utf8",
    ),
  ) as ObserverData;

describe("an Observer page", () => {
  it("carries the participants' items compressed apart from the run's data", async () => {
    const data = await live();
    const html = renderObserverHtml(data);
    const shellText =
      /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ??
      "";
    const itemIds = data.streams.flatMap(
      (stream) => stream.actor?.items.map((item) => item.id) ?? [],
    );
    expect(itemIds.filter((id) => shellText.includes(`"id":"${id}"`))).toEqual([]);
    expect(readObserverPage(html)).toEqual(withObserverEndings(data));
  });

  it("packs each participant's items on their own, so no string holds two participants' items", async () => {
    const data = await twoParticipants();
    const stringify = vi.spyOn(JSON, "stringify");
    const html = renderObserverHtml(data);
    const written = stringify.mock.results.flatMap((result) =>
      typeof result.value === "string" ? [result.value] : [],
    );
    stringify.mockRestore();
    expect(
      written.filter((text) => text.includes(FIRST_ITEM) && text.includes(SECOND_ITEM)),
    ).toEqual([]);
    const element = /<script id="observer-items" type="application\/json">([^<]*)<\/script>/.exec(
      html,
    )?.[1];
    const items = JSON.parse(element ?? "null") as {
      schema: string;
      runId: string;
      streams: Record<string, unknown>;
    };
    expect(items.schema).toBe("humanish.observer-items.v2");
    expect(items.runId).toBe(data.run.runId);
    expect(Object.keys(items.streams)).toEqual(["stream-001", "stream-002"]);
    const decoded = Object.values(items.streams).map((packed) =>
      JSON.stringify(
        JSON.parse(gunzipSync(Buffer.from(String(packed), "base64")).toString("utf8")),
      ),
    );
    expect(decoded.map((text) => [text.includes(FIRST_ITEM), text.includes(SECOND_ITEM)])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(readObserverPage(html)).toEqual(withObserverEndings(data));
  });
});

const FIRST_ITEM = '"id":"one-';
const SECOND_ITEM = '"id":"two-';

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
