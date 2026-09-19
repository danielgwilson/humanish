import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it } from "vitest";
import { createStudyAnalysisProvider, type StudyAnalysisProviderRequest } from "../src/study-analysis-provider.js";

// Captured envelope, as in study-analysis-provider.test.ts; no model request here.
const captured = readFileSync(new URL("./fixtures/openai-closing-report/typed-closing-report.json", import.meta.url), "utf8");
const request: StudyAnalysisProviderRequest = {
  model: "gpt-5.6-sol", instructions: "Synthetic transport proof", evidence: "Synthetic evidence", images: [],
  schema: {}, maxOutputTokens: 8192, timeoutMs: 4000
};

async function localServer(handle: (response: ServerResponse) => void) {
  let requests = 0;
  const server = createServer((incoming, response) => {
    requests += 1;
    incoming.resume();
    handle(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url, requests: () => requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

it("survives a delayed response past the process fetch header timeout without replacing that dispatcher", async () => {
  const server = await localServer(response => {
    const timer = setTimeout(() => response.end(captured), 1800);
    response.on("close", () => clearTimeout(timer));
  });
  const previous = getGlobalDispatcher();
  const shortDeadline = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
  setGlobalDispatcher(shortDeadline);
  try {
    // Control proves the runtime/fixture reproduces the hidden timeout.
    await expect(fetch(server.url)).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    const provider = createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn: async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      return fetch(server.url, init);
    } });
    expect(await provider(request)).toMatchObject({ status: "completed", dispatched: true });
    expect(getGlobalDispatcher()).toBe(shortDeadline);
    expect(server.requests()).toBe(2);
  } finally {
    setGlobalDispatcher(previous);
    await shortDeadline.destroy();
    await server.close();
  }
}, 10_000);

it.each(["headers", "body", "caller"])("still aborts stalled %s and releases the connection without retry", async kind => {
  let closed = false;
  const server = await localServer(response => {
    response.on("close", () => { closed = true; });
    if (kind === "body") { response.writeHead(200); response.write('{"status":'); }
  });
  const controller = new AbortController();
  const timer = kind === "caller" ? setTimeout(() => controller.abort(), 150) : undefined;
  try {
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key",
      fetchFn: (_url, init) => fetch(server.url, init) })({ ...request,
      timeoutMs: kind === "caller" ? 4000 : 150, signal: controller.signal });
    expect(result).toMatchObject({ status: kind === "caller" ? "cancelled" : "timed_out",
      errorCode: kind === "caller" ? "cancelled" : "timeout", usage: null, dispatched: true });
    await expect.poll(() => closed).toBe(true);
    expect(server.requests()).toBe(1);
  } finally {
    clearTimeout(timer);
    await server.close();
  }
});
