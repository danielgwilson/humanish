import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ObserverData } from "../../src/observer/data.js";
import {
  itemsCoverShell,
  joinObserverData,
  splitObserverData,
} from "../../src/observer/participant-items.js";

// The pinned live snapshot: participants with screenshots, reasoning and click items.
const live = async (): Promise<ObserverData> =>
  JSON.parse(
    await readFile(
      path.join(process.cwd(), "tests", "golden", "observer-data", "live.json"),
      "utf8",
    ),
  ) as ObserverData;

describe("the Observer's data apart from its participants' items", () => {
  it("holds no item, and the items join back into the same data", async () => {
    const data = await live();
    const itemIds = data.streams.flatMap(
      (stream) => stream.actor?.items.map((item) => item.id) ?? [],
    );
    expect(itemIds.length).toBeGreaterThan(10);

    const screenshots = data.streams.flatMap((stream) =>
      stream.artifacts.filter((artifact) => artifact.kind === "screenshot"),
    );
    expect(screenshots.length).toBeGreaterThan(10);

    const { shell, items } = splitObserverData(data);
    const shellText = JSON.stringify(shell);
    for (const stream of shell.streams) expect(stream.actor).not.toHaveProperty("items");
    // A participant's screenshot list grows with its items, so it travels with them.
    expect(
      screenshots.filter((artifact) => shellText.includes(`"path":"${artifact.path}"`)),
    ).toEqual([]);
    expect(itemIds.filter((id) => shellText.includes(`"id":"${id}"`))).toEqual([]);
    expect(joinObserverData(shell, items)).toEqual(data);
  });

  it("keeps a running participant's items apart the same way", async () => {
    const data = await live();
    const [first, ...rest] = data.streams;
    const { actor, ...stream } = first!;
    const running: ObserverData = {
      ...data,
      streams: [
        {
          ...stream,
          liveActor: { schema: "humanish.live-actor.v1", updatedAt: "t", items: actor!.items },
        },
        ...rest,
      ],
    };
    const { shell, items } = splitObserverData(running);
    expect(shell.streams[0]!.liveActor).toEqual({
      schema: "humanish.live-actor.v1",
      updatedAt: "t",
    });
    expect(joinObserverData(shell, items)).toEqual(running);
  });

  it("keeps the items of a stream whose id is an Object prototype key", async () => {
    const data = await live();
    const [first, ...rest] = data.streams;
    const odd: ObserverData = { ...data, streams: [{ ...first!, id: "__proto__" }, ...rest] };
    const { shell, items } = splitObserverData(odd);
    const sent = JSON.parse(JSON.stringify(items)) as typeof items;
    expect(joinObserverData(shell, sent)).toEqual(odd);
  });

  it("says whether items cover every participant the data names, for this run", async () => {
    const data = await live();
    const { shell, items } = splitObserverData(data);
    expect(itemsCoverShell(shell, items)).toBe(true);
    expect(itemsCoverShell(shell, { ...items, runId: "another-run" })).toBe(false);
    expect(itemsCoverShell(shell, { ...items, streams: {} })).toBe(false);
  });

  it("shows a participant with no recorded steps when the items are missing or another run's", async () => {
    const data = await live();
    const { shell, items } = splitObserverData(data);
    for (const joined of [
      joinObserverData(shell, null),
      joinObserverData(shell, { ...items, runId: "another-run" }),
    ])
      expect(joined.streams.map((stream) => stream.actor?.items.length)).toEqual(
        data.streams.map((stream) => (stream.actor === undefined ? undefined : 0)),
      );
  });
});
