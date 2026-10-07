// POST /api/notes: the one write an Observer server accepts. A loopback server takes a note only
// with the token its page carries, from that page's own origin; everything else is refused.
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderObserver, serveObserver, type ObserverServer } from "../../src/observer/render.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";
import { noteEntries } from "../helpers/note-files.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { FIRST_PARTICIPANT, writeTimedRun } from "../helpers/timed-run.js";

const RUN = "noted-served-run";
const servers: Array<ObserverServer | ServeLibraryServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Reply {
  status: number;
  body: string;
}

/** node:http, so a test can send any Host, Origin or body framing. */
function send(
  port: number,
  requestPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** The run-notes slot of a served page. */
function notesSlot(html: string): {
  notes: { notes: Array<{ text: string }> } | null;
  write: { token: string } | null;
} {
  const match = /<script id="run-notes" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("the page has no run-notes slot");
  return JSON.parse(match[1]!);
}

async function servedRun(options: { exposed?: boolean } = {}) {
  const cwd = await makeTestTempDir("humanish-notes-write-");
  const runDir = await writeTimedRun(cwd, RUN);
  const rendered = await renderObserver(cwd, RUN, { open: false });
  const server = await serveObserver(rendered, {
    open: false,
    scope: "run",
    ...(options.exposed ? { exposed: true } : {}),
  });
  servers.push(server);
  const page = await send(server.port, "/observer/index.html", {
    headers: { host: `127.0.0.1:${server.port}` },
  });
  return { cwd, runDir, server, token: notesSlot(page.body).write?.token ?? "" };
}

function note(
  port: number,
  token: string | undefined,
  body: unknown = { runId: RUN, atMs: 60_000, participant: FIRST_PARTICIPANT, text: "Here." },
  headers: Record<string, string> = {},
): Promise<Reply> {
  return send(port, "/api/notes", {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json",
      ...(token === undefined ? {} : { "x-humanish-notes-token": token }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const errorCode = (reply: Reply): unknown =>
  (JSON.parse(reply.body) as { error?: { code?: unknown } }).error?.code;

describe("adding a note through a loopback Observer", () => {
  it("saves a note sent with the page's token from its origin, and the reloaded page shows it", async () => {
    const { runDir, server, token } = await servedRun();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const reply = await note(server.port, token);

    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toMatchObject({
      ok: true,
      note: { atMs: 60_000, participant: FIRST_PARTICIPANT, text: "Here." },
    });
    const { note: saved } = JSON.parse(reply.body) as { note: { id: string } };
    expect(await noteEntries(runDir)).toEqual([`${saved.id}.json`]);
    const reloaded = await send(server.port, "/observer/index.html", {
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(notesSlot(reloaded.body).notes?.notes.map((item) => item.text)).toEqual(["Here."]);
    // The saved page is rendered again once the server has finished with the write.
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const page = await readFile(path.join(runDir, "observer", "index.html"), "utf8");
    expect(notesSlot(page)).toMatchObject({ notes: { notes: [{ text: "Here." }] }, write: null });
  });
});

describe("refusing a note through a loopback Observer", () => {
  it("refuses a request without the token or with another one", async () => {
    const { runDir, server, token } = await servedRun();

    for (const sent of [undefined, "", "x".repeat(43), `${token}x`]) {
      const reply = await note(server.port, sent);
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("HUMANISH_NOTES_TOKEN");
    }
    expect(await noteEntries(runDir)).toEqual([]);
  });

  it("refuses a request from another origin, with no origin, or for another host", async () => {
    const { runDir, server, token } = await servedRun();
    const port = server.port;

    const refused = [
      await note(port, token, undefined, { origin: "http://evil.example" }),
      await note(port, token, undefined, { origin: "null" }),
      await note(port, token, undefined, { origin: `http://localhost:${port}` }),
      await note(port, token, undefined, { origin: `https://127.0.0.1:${port}` }),
      // A rebound name reaching the loopback port: its own origin, the wrong host.
      await note(port, token, undefined, {
        host: `evil.example:${port}`,
        origin: `http://evil.example:${port}`,
      }),
    ];
    const withoutOrigin = await send(port, "/api/notes", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "x-humanish-notes-token": token,
      },
      body: JSON.stringify({ runId: RUN, atMs: 0, participant: null, text: "No origin." }),
    });

    for (const reply of [...refused, withoutOrigin]) {
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("HUMANISH_NOTES_ORIGIN");
    }
    expect(await noteEntries(runDir)).toEqual([]);
  });

  it("takes the participant's own id from the study and stores its stream id", async () => {
    const { server, token } = await servedRun();

    const reply = await note(server.port, token, {
      runId: RUN,
      atMs: 1000,
      participant: "first-visitor",
      text: "By study id.",
    });

    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toMatchObject({ note: { participant: FIRST_PARTICIPANT } });
  });

  it("accepts a page opened at localhost from its own origin", async () => {
    const { server, token } = await servedRun();

    const reply = await note(server.port, token, undefined, {
      host: `localhost:${server.port}`,
      origin: `http://localhost:${server.port}`,
    });

    expect(reply.status).toBe(201);
  });

  it("refuses a body over 16 KiB before reading it, declared or streamed", async () => {
    const { runDir, server, token } = await servedRun();
    const large = JSON.stringify({
      runId: RUN,
      atMs: 0,
      participant: null,
      text: "x".repeat(20_000),
    });

    const declared = await note(server.port, token, large);
    const streamed = await note(server.port, token, large, { "transfer-encoding": "chunked" });

    for (const reply of [declared, streamed]) {
      expect(reply.status).toBe(413);
      expect(errorCode(reply)).toBe("HUMANISH_NOTES_TOO_LARGE");
    }
    expect(await noteEntries(runDir)).toEqual([]);
  });

  it("refuses a body that is not a JSON note", async () => {
    const { server, token } = await servedRun();

    for (const [body, headers] of [
      ["{ not json", {}],
      [JSON.stringify({ runId: RUN, atMs: "soon", text: "Here." }), {}],
      [
        JSON.stringify({ runId: RUN, atMs: 0, participant: null, text: "Here." }),
        { "content-type": "text/plain" },
      ],
    ] as const) {
      const reply = await note(server.port, token, body, headers);
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
      expect(errorCode(reply)).toMatch(/^HUMANISH_NOTES_BODY$/);
    }
  });

  it("refuses a participant the run does not have", async () => {
    const { server, token } = await servedRun();

    const reply = await note(server.port, token, {
      runId: RUN,
      atMs: 0,
      participant: "stream-three",
      text: "Who?",
    });

    expect(reply.status).toBe(400);
    expect(errorCode(reply)).toBe("HUMANISH_NOTE_UNKNOWN_PARTICIPANT");
  });

  it("refuses a run id that is not the served run, including traversal", async () => {
    const { cwd, server, token } = await servedRun();
    await writeTimedRun(path.join(cwd, "sibling"), "sibling-run").catch(() => undefined);

    for (const runId of ["../noted-served-run", "sibling-run", "noted-served-run/..", ".."]) {
      const reply = await note(server.port, token, {
        runId,
        atMs: 0,
        participant: null,
        text: "x",
      });
      expect(reply.status).toBe(404);
      expect(errorCode(reply)).toBe("HUMANISH_RUN_NOT_FOUND");
    }
  });

  it("answers only POST at /api/notes and refuses other paths and methods that write", async () => {
    const { runDir, server, token } = await servedRun();
    const headers = {
      host: `127.0.0.1:${server.port}`,
      origin: `http://127.0.0.1:${server.port}`,
      "content-type": "application/json",
      "x-humanish-notes-token": token,
    };
    const body = JSON.stringify({ runId: RUN, atMs: 0, participant: null, text: "x" });

    const replies = [
      await send(server.port, "/api/notes", { headers }),
      await send(server.port, "/api/notes/", { method: "POST", headers, body }),
      await send(server.port, "/api//notes", { method: "POST", headers, body }),
      await send(server.port, "/api/notes/../../notes/x.json", { method: "POST", headers, body }),
      await send(server.port, "/observer/index.html", { method: "POST", headers, body }),
      await send(server.port, "/api/notes", { method: "PUT", headers, body }),
    ];

    for (const reply of replies) expect(reply.status).toBe(405);
    expect(await noteEntries(runDir)).toEqual([]);
  });

  it("refuses to write through a notes folder that links outside the run", async () => {
    const { cwd, runDir, server, token } = await servedRun();
    const outside = path.join(cwd, "outside-notes");
    await mkdir(outside);
    await symlink(outside, path.join(runDir, "notes"));

    const reply = await note(server.port, token);

    expect(reply.status).toBe(409);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("an exposed Observer", () => {
  it("serves its page without a token and refuses every note", async () => {
    const { runDir, server } = await servedRun({ exposed: true });
    const page = await send(server.port, "/observer/index.html", {
      headers: { host: `127.0.0.1:${server.port}` },
    });

    expect(notesSlot(page.body).write).toBeNull();
    for (const token of [undefined, "x".repeat(43)]) {
      const reply = await note(server.port, token);
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("HUMANISH_NOTES_EXPOSED");
    }
    expect(await noteEntries(runDir)).toEqual([]);
  });
});

describe("the run library", () => {
  async function library(expose: boolean) {
    const cwd = await makeTestTempDir("humanish-notes-library-");
    const runDir = await writeTimedRun(cwd, RUN);
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose,
      edgeAuthed: expose,
      ...(expose ? { publicOrigin: "https://observer.example.com" } : {}),
    });
    if (!started.ok) throw new Error(started.error.message);
    servers.push(started.server);
    const page = await send(started.server.port, `/_humanish/runs/${RUN}/observer/index.html`, {
      headers: { host: `127.0.0.1:${started.server.port}` },
    });
    return { runDir, port: started.server.port, slot: notesSlot(page.body) };
  }

  it("takes a note for a run it serves on loopback", async () => {
    const { runDir, port, slot } = await library(false);

    const reply = await note(port, slot.write?.token);

    expect(reply.status).toBe(201);
    expect(await noteEntries(runDir)).toHaveLength(1);
  });

  it("refuses every note when exposed and serves no token", async () => {
    const { runDir, port, slot } = await library(true);

    const reply = await note(port, "x".repeat(43));

    expect(slot.write).toBeNull();
    expect(reply.status).toBe(403);
    expect(errorCode(reply)).toBe("HUMANISH_NOTES_EXPOSED");
    expect(await noteEntries(runDir)).toEqual([]);
  });
});
