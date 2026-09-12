// @ts-check
import { once } from "node:events";
import { createServer } from "node:http";

/** A synthetic app with a real loopback HTTP state/action contract. */
export async function startLocalApp() {
  let greeted = false;
  let messages = 0;
  let stateReads = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/state") {
      stateReads += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ greeted, messages }));
    } else if (request.method === "POST" && request.url === "/chat") {
      // The demo accepts only a short synthetic message; it stores no raw text.
      let text = "";
      for await (const chunk of request) {
        text += chunk.toString();
        if (text.length > 1024) {
          response.writeHead(413).end();
          return;
        }
      }
      messages += 1;
      if (text.toLowerCase().includes("hello")) greeted = true;
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");

  return {
    appUrl: `http://127.0.0.1:${address.port}/`,
    // These counters make real HTTP reads and state-changing writes inspectable.
    getReceipt: () => ({ greeted, messages, stateReads, serverClosed: !server.listening }),
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve(undefined));
        server.closeAllConnections();
      });
    }
  };
}
