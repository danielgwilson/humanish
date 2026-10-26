import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultFetch } from "../../../src/actors/computer-use/provider-http.js";

// A local server on port 0 stands in for a provider that asks the client to slow down.
const server = createServer((_req, res) => {
  res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
  res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
});
let url = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the default fetch", () => {
  it("hands a provider the Retry-After header of a real response", async () => {
    const res = await defaultFetch()(url, { method: "POST", headers: {}, body: "{}" });
    expect(res.status).toBe(429);
    expect(res.headers?.get("retry-after")).toBe("7");
  });
});
