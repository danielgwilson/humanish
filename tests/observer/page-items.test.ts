import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
