import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OBSERVER_STATIC_HOST,
  observerStaticContentType,
  respondToObserverStaticRequest,
  serveObserverStatic
} from "../src/observer-static.js";

const SECRET_BODY = "TOP-SECRET-do-not-serve\n";
const ENTRY = "observer/index.html";

interface RunFixture {
  /** The served loopback root: a single run's bundle directory. */
  runDir: string;
  /** Parent of runDir (simulates `.mimetic/runs/`), holds out-of-scope files. */
  runsDir: string;
}

async function withRunDir<T>(callback: (fixture: RunFixture) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-observer-static-"));
  const runsDir = path.join(tempRoot, "runs");
  const runDir = path.join(runsDir, "run");
  const observerDir = path.join(runDir, "observer");

  try {
    await mkdir(observerDir, { recursive: true });
    // Files inside the run dir — all of these SHOULD be reachable over loopback.
    await writeFile(path.join(observerDir, "index.html"), "<!doctype html><title>Mimetic Observer</title>", "utf8");
    await writeFile(path.join(observerDir, "observer-data.json"), JSON.stringify({ schema: "mimetic.observer-data.v1" }), "utf8");
    await writeFile(path.join(observerDir, "client.js"), "console.log('observer');", "utf8");
    await writeFile(path.join(observerDir, "theme.css"), ":root{color:white}", "utf8");
    await writeFile(path.join(observerDir, "badge.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8");
    await writeFile(path.join(runDir, "run.json"), JSON.stringify({ schema: "mimetic.run-bundle.v1" }), "utf8");
    await writeFile(path.join(runDir, "events.ndjson"), "{\"event\":\"start\"}\n", "utf8");

    // Out-of-scope files: a sibling run and a secret in the parent runs/ dir.
    // Path traversal must never reach above the served run dir.
    const otherRun = path.join(runsDir, "other-run");
    await mkdir(otherRun, { recursive: true });
    await writeFile(path.join(otherRun, "run.json"), "OTHER-RUN-private\n", "utf8");
    await writeFile(path.join(runsDir, "secret.txt"), SECRET_BODY, "utf8");

    return await callback({ runDir, runsDir });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function callHandler(runDir: string, url: string, method = "GET"): Promise<CapturedResponse> {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: "" };
  const response = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.statusCode = status;
      captured.headers = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
      );
      this.headersSent = true;
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      return this;
    }
  };

  const request = { method, url } as Pick<IncomingMessage, "method" | "url">;
  await respondToObserverStaticRequest({ root: runDir, redirectRootTo: ENTRY }, request, response as unknown as ServerResponse);
  return captured;
}

describe("observer static content type", () => {
  it("maps the asset kinds the Observer ships", () => {
    expect(observerStaticContentType("a/index.html")).toBe("text/html; charset=utf-8");
    expect(observerStaticContentType("a/client.js")).toBe("text/javascript; charset=utf-8");
    expect(observerStaticContentType("a/theme.css")).toBe("text/css; charset=utf-8");
    expect(observerStaticContentType("a/observer-data.json")).toBe("application/json; charset=utf-8");
    expect(observerStaticContentType("a/events.ndjson")).toBe("application/x-ndjson; charset=utf-8");
    expect(observerStaticContentType("a/frame.png")).toBe("image/png");
    expect(observerStaticContentType("a/badge.svg")).toBe("image/svg+xml");
    expect(observerStaticContentType("a/mystery.bin")).toBe("application/octet-stream");
  });
});

describe("observer static request handler", () => {
  it("redirects / to the observer entry page", async () => {
    await withRunDir(async ({ runDir }) => {
      const response = await callHandler(runDir, "/");
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`/${ENTRY}`);
    });
  });

  it("serves observer/index.html with the html content type and no-store caching", async () => {
    await withRunDir(async ({ runDir }) => {
      const response = await callHandler(runDir, `/${ENTRY}`);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toContain("Mimetic Observer");
    });
  });

  it("serves observer assets with the correct content types", async () => {
    await withRunDir(async ({ runDir }) => {
      const js = await callHandler(runDir, "/observer/client.js");
      expect(js.statusCode).toBe(200);
      expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");

      const css = await callHandler(runDir, "/observer/theme.css");
      expect(css.statusCode).toBe(200);
      expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");

      const svg = await callHandler(runDir, "/observer/badge.svg");
      expect(svg.statusCode).toBe(200);
      expect(svg.headers["content-type"]).toBe("image/svg+xml");

      const data = await callHandler(runDir, "/observer/observer-data.json");
      expect(data.statusCode).toBe(200);
      expect(data.headers["content-type"]).toBe("application/json; charset=utf-8");
    });
  });

  it("resolves the Observer's relative artifact links inside the run dir", async () => {
    await withRunDir(async ({ runDir }) => {
      // From /observer/index.html the client requests ../run.json -> /run.json.
      const runJson = await callHandler(runDir, "/run.json");
      expect(runJson.statusCode).toBe(200);
      expect(runJson.headers["content-type"]).toBe("application/json; charset=utf-8");

      const events = await callHandler(runDir, "/events.ndjson");
      expect(events.statusCode).toBe(200);
      expect(events.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    });
  });

  it("returns 404 for a missing file", async () => {
    await withRunDir(async ({ runDir }) => {
      const response = await callHandler(runDir, "/observer/does-not-exist.png");
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("TOP-SECRET");
    });
  });

  it("refuses path traversal and never escapes the run dir", async () => {
    await withRunDir(async ({ runDir }) => {
      // Percent-encoded ../ that decodes to the parent runs/ dir.
      const encodedSecret = await callHandler(runDir, "/%2e%2e/secret.txt");
      expect([403, 404]).toContain(encodedSecret.statusCode);
      expect(encodedSecret.body).not.toContain("TOP-SECRET");

      // Escape into a sibling run's bundle must be refused.
      const siblingRun = await callHandler(runDir, "/%2e%2e/other-run/run.json");
      expect([403, 404]).toContain(siblingRun.statusCode);
      expect(siblingRun.body).not.toContain("OTHER-RUN-private");

      const encodedDeep = await callHandler(runDir, "/%2e%2e/%2e%2e/etc/passwd");
      expect([403, 404]).toContain(encodedDeep.statusCode);
      expect(encodedDeep.body).not.toContain("root:");

      // Plain form must never return the sibling secret either.
      const plain = await callHandler(runDir, "/../secret.txt");
      expect([403, 404]).toContain(plain.statusCode);
      expect(plain.body).not.toContain("TOP-SECRET");

      // A NUL byte must be rejected, not passed to the filesystem.
      const nul = await callHandler(runDir, "/run.json%00.png");
      expect([400, 404]).toContain(nul.statusCode);
    });
  });

  it("rejects non-GET/HEAD methods", async () => {
    await withRunDir(async ({ runDir }) => {
      const response = await callHandler(runDir, `/${ENTRY}`, "DELETE");
      expect(response.statusCode).toBe(405);
    });
  });
});

describe("observer static server", () => {
  it("binds 127.0.0.1 on an ephemeral port and serves the run over loopback http", async () => {
    await withRunDir(async ({ runDir }) => {
      const server = await serveObserverStatic({ root: runDir, port: 0, entryPath: ENTRY });
      try {
        expect(server.host).toBe(OBSERVER_STATIC_HOST);
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/observer\/index\.html$/);

        const entryResponse = await fetch(server.url);
        expect(entryResponse.status).toBe(200);
        expect(entryResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await entryResponse.text()).toContain("Mimetic Observer");

        // Hitting the root follows the redirect to the entry page.
        const base = `http://${server.host}:${server.port}/`;
        const rootResponse = await fetch(base);
        expect(rootResponse.status).toBe(200);
        expect(await rootResponse.text()).toContain("Mimetic Observer");

        // Artifact link target inside the run dir resolves.
        const runJson = await fetch(new URL("run.json", base));
        expect(runJson.status).toBe(200);
        expect(((await runJson.json()) as { schema: string }).schema).toBe("mimetic.run-bundle.v1");

        const observerData = await fetch(new URL("observer/observer-data.json", base));
        expect(observerData.status).toBe(200);
        expect(((await observerData.json()) as { schema: string }).schema).toBe("mimetic.observer-data.v1");

        const missing = await fetch(new URL("observer/nope.json", base));
        expect(missing.status).toBe(404);
      } finally {
        await server.close();
      }
    });
  });
});
