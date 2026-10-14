import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { renderObserverHtml } from "../../src/observer/artifact.js";
import { withObserverEndings, type ObserverData } from "../../src/observer/data.js";
import { scanEncodedTextCached } from "../../src/evidence/encoded-text.js";
import { decodeEntry, readObserverPage } from "../helpers/observer-page.js";

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
      streams: string[];
    };
    expect(items.schema).toBe("humanish.observer-items.v2");
    expect(items.runId).toBe(data.run.runId);
    expect(items.streams.map((packed) => decodeEntry(packed).id)).toEqual([
      "stream-001",
      "stream-002",
    ]);
    const decoded = items.streams.map((packed) => JSON.stringify(decodeEntry(packed)));
    expect(decoded.map((text) => [text.includes(FIRST_ITEM), text.includes(SECOND_ITEM)])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(readObserverPage(html)).toEqual(withObserverEndings(data));
  });

  it("scans clean as verify scans it when a participant's stream id reads as a credential name", async () => {
    // A stream id followed by `:` and a long base64 value reads as `TOKEN: <secret>`.
    const data = await live();
    const [stream] = data.streams;
    const named = { ...data, streams: [{ ...stream!, id: "GITHUB_TOKEN" }] };
    const scan = (text: string) => scanEncodedTextCached(text, { allowOpaqueBase64: true });
    expect(scan(JSON.stringify(named)).sensitive).toBe(false);
    const html = renderObserverHtml(named);
    expect(scan(html)).toEqual({ sensitive: false, opaque: false });
    expect(readObserverPage(html)).toEqual(withObserverEndings(named));
  });

  it("scans clean as verify scans it when two participants' stream ids read as one E2B URL", async () => {
    // User info may run over quotes, commas and base64, so `https://` and a later id shaped like an
    // address at an E2B host read as one URL unless a slash or space comes between them. The
    // address is built at run time so this file holds none.
    const address = ["person", "e2b.example"].join("@");
    const data = await live();
    const [stream] = data.streams;
    const named = {
      ...data,
      streams: ["https://", address].map((id) => ({
        ...stream!,
        id,
        label: "Synthetic participant",
        artifacts: [],
        actor: { ...stream!.actor!, items: [] },
      })),
    };
    const scan = (text: string) => scanEncodedTextCached(text, { allowOpaqueBase64: true });
    expect(scan(JSON.stringify(named)).sensitive).toBe(false);
    const html = renderObserverHtml(named);
    expect(scan(html)).toEqual({ sensitive: false, opaque: false });
    expect(readObserverPage(html)).toEqual(withObserverEndings(named));
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
