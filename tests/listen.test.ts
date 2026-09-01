import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { listenOnLoopback, PortInUseError, probePortHolder } from "../src/listen.js";
import { freePort } from "./helpers/free-port.js";

// `listen EADDRINUSE` surfaced as HUMANISH_UNEXPECTED, the catch-all for "a handler threw" (#484).
// Something already on the port is the most expected condition a serve command has.
describe("listenOnLoopback", () => {
  const open: Array<{ close: (cb?: () => void) => unknown }> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); })));
  });

  it("names a taken port and says whose it is, instead of throwing Node's raw error", async () => {
    const port = await freePort();
    const holder: NetServer = createNetServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    open.push(holder);
    const server = createHttpServer();
    open.push(server);
    await expect(listenOnLoopback(server, port, async () => "other")).rejects.toMatchObject({
      name: "PortInUseError",
      port,
      holder: "other",
      message: expect.stringContaining(`already listening on 127.0.0.1:${port}`)
    });
    await expect(listenOnLoopback(server, port, async () => "humanish")).rejects.toMatchObject({
      holder: "humanish",
      message: expect.stringContaining("another humanish process")
    });
  });

  it("binds a free port on loopback and reports the port it got", async () => {
    const server = createHttpServer();
    open.push(server);
    const port = await listenOnLoopback(server, 0);
    expect(port).toBeGreaterThan(0);
    const address = server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });

  it("recognises a humanish server by its JSON schema, and nothing else", async () => {
    const ours = createHttpServer((request, response) => {
      if (request.url === "/_humanish/history.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ schema: "humanish.run-history.v1", runs: [] }));
        return;
      }
      response.writeHead(404); response.end();
    });
    open.push(ours);
    const oursPort = await listenOnLoopback(ours, 0);
    expect(await probePortHolder(oursPort)).toBe("humanish");

    const theirs = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<main>landing page</main>"); });
    open.push(theirs);
    const theirsPort = await listenOnLoopback(theirs, 0);
    expect(await probePortHolder(theirsPort)).toBe("other");

    // Nothing listening at all: "other", never a hang.
    const silent = await freePort();
    expect(await probePortHolder(silent)).toBe("other");
  });

  it("is a PortInUseError a caller can instanceof", () => {
    expect(new PortInUseError(8791, "other")).toBeInstanceOf(Error);
  });
});
