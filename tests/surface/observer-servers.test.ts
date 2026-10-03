// src/observer serves Observer pages through two HTTP servers: one run (render.ts) and the run
// library (serve.ts). A third would be a second way to serve the same evidence, with its own
// containment and headers to keep in step, so this test caps the count.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps src/observer at two createServer( calls", async () => {
  const dir = "src/observer";
  const counts: Record<string, number> = {};
  for (const name of await readdir(dir, { recursive: true })) {
    if (!name.endsWith(".ts")) continue;
    const hits = (await readFile(path.join(dir, name), "utf8")).split("createServer(").length - 1;
    if (hits > 0) counts[name] = hits;
  }
  expect(counts).toEqual({ "render.ts": 1, "serve.ts": 1 });
});
