import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const site = resolve("site");
const repoRoot = process.cwd();

// Next prerenders the routes with the site as the working directory, and they read their fonts
// from there.
beforeAll(() => process.chdir(site));
afterAll(() => process.chdir(repoRoot));
afterEach(() => vi.unstubAllGlobals());

describe("site Open Graph images", () => {
  it.each(["app/opengraph-image.tsx", "app/demo/opengraph-image.tsx"])(
    "%s renders a 1200x630 PNG while the network is unreachable",
    async (file) => {
      // next/og loads its layout engine from a data: URL, which needs no network.
      const realFetch = globalThis.fetch;
      const requested: string[] = [];
      vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
        const [input] = args;
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith("data:")) return realFetch(...args);
        requested.push(url);
        return Promise.reject(new TypeError("fetch failed"));
      });
      const route = (await import(pathToFileURL(join(site, file)).href)) as {
        default: () => Response | Promise<Response>;
      };
      const png = Buffer.from(await (await route.default()).arrayBuffer());
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      // IHDR: width and height are the first two fields after the 8-byte signature and chunk header.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
      expect(requested).toEqual([]);
    },
  );
});
