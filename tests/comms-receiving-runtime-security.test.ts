import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCommsConnection } from "../src/comms-connections.js";
import { inspectCommsRecovery, type CommsReceivingRun } from "../src/comms-receiving.js";
import { prepareReceivingRun } from "../src/comms-receiving-runtime.js";
import type { ReceivingSurfaceFile } from "../src/comms-receiving-types.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../src/run-paths.js";

// Synthetic canaries and explicit mutations of the sanitized, live-derived wire fixtures.
// No test discovers host credentials or sends network requests.
const KEY = "synthetic-agentmail-management-key-canary";
const ACCOUNT = "organization-fixture-1";
const RESOURCE = "opaque-provider-inbox-canary";
const ADDRESS = "recipient@example.test";
const MESSAGE = "message-fixture-1";
const CODE = "123456";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
type Wire = { status: number; body: Record<string, any> | null };
function fixture(name: string): Wire {
  return JSON.parse(readFileSync(new URL(`./fixtures/agentmail-receiving/${name}.json`, import.meta.url), "utf8")) as Wire;
}
function response(wire: Wire): Response {
  return new Response(wire.body === null ? null : JSON.stringify(wire.body), { status: wire.status, headers: { "Content-Type": "application/json" } });
}
function config(): LabConfig {
  const parsed = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "receiving-security",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
    actors: [{ type: "openai-computer-use", mission: "Read your email." }],
    execution: { target: "e2b-desktop" }, scenario: { mode: "live" },
    comms: { email: { connection: "mail" } } });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("host-only receiving runtime boundaries", () => {
  let base: string;
  let cwd: string;
  let stateDir: string;
  let runPaths: PreparedRunArtifactPaths;
  let env: NodeJS.ProcessEnv;
  let registered: Set<string>;
  const runs: CommsReceivingRun[] = [];
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "humanish-mail-boundary-"));
    cwd = path.join(base, "project");
    await mkdir(cwd);
    const stateHome = path.join(base, "private-state");
    stateDir = path.join(stateHome, "humanish", "comms");
    vi.stubEnv("XDG_STATE_HOME", stateHome);
    env = { HUMANISH_STRICT_KEYS: "1", AGENTMAIL_API_KEY: KEY };
    registered = new Set();
    expect((await saveCommsConnection(cwd, "mail")).ok).toBe(true);
    runPaths = await prepareRunArtifactPaths(cwd, "boundary-study");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network call"); }));
  });
  afterEach(async () => {
    for (const run of runs.splice(0)) await run.finish();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });
  function prepare(lab = config()) {
    return prepareReceivingRun({ cwd, runId: "boundary-study", config: lab, env,
      participants: ["participant-a"], runPaths, registerSecrets: values => values.forEach(value => registered.add(value)) });
  }

  it.each([
    ["configured env name", { env: ["AGENTMAIL_API_KEY"] }, {}],
    ["env alias", { env: ["APP_SENDING_KEY"] }, { APP_SENDING_KEY: KEY }],
    ["trimmed env alias", { env: ["APP_SENDING_KEY"] }, { APP_SENDING_KEY: ` ${KEY}\n` }],
    ["configured literal name", { envValues: { AGENTMAIL_API_KEY: "another-value" } }, {}],
    ["literal alias", { envValues: { APP_SENDING_KEY: KEY } }, {}],
    ["trimmed literal alias", { envValues: { APP_SENDING_KEY: `\n${KEY} ` } }, {}]
  ])("rejects management credential forwarding through %s before any provider allocation", async (_name, subject, values) => {
    const lab = config();
    Object.assign(lab.subject, subject);
    Object.assign(env, values);
    await expect(prepare(lab)).rejects.toThrow("management credential cannot be forwarded");
    expect(fetch).not.toHaveBeenCalled();
    expect(registered.has(KEY)).toBe(true);
    await expect(stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(runPaths.physicalRunRoot)).toEqual([]);
  });

  it("keeps API authority on the host while real wire responses become a bounded recipient surface and counts-only evidence", async () => {
    let clientId = "";
    let deleted = false;
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      requests.push({ url, init: init ?? {} });
      if (url.origin === "https://cdn.agentmail.to") return new Response(Buffer.from(PIXEL, "base64"));
      expect(url.origin).toBe("https://api.agentmail.to");
      if (url.pathname === "/v0/auth/me") return response(fixture("auth"));
      const inbox = fixture("inbox");
      inbox.body!.inbox_id = RESOURCE;
      if (url.pathname === "/v0/inboxes" && init?.method === "POST") {
        clientId = JSON.parse(String(init.body)).client_id;
        inbox.body!.client_id = clientId;
        return response(inbox);
      }
      expect(clientId).not.toBe("");
      expect(url.pathname.startsWith(`/v0/inboxes/${RESOURCE}`)).toBe(true);
      if (url.pathname.endsWith("/attachments/attachment-fixture-1")) return response(fixture("attachment"));
      if (url.pathname.endsWith(`/messages/${MESSAGE}`)) {
        const message = fixture("message");
        message.body!.inbox_id = RESOURCE;
        return response(message);
      }
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("labels")).toBe("received");
        const page = fixture("messages");
        page.body!.messages[0].inbox_id = RESOURCE;
        return response(page);
      }
      if (init?.method === "DELETE") { deleted = true; return response(fixture("delete-accepted")); }
      inbox.body!.client_id = clientId;
      return response(deleted ? fixture("absent") : inbox);
    });
    vi.stubGlobal("fetch", fetcher);
    const run = await prepare();
    expect(run).toBeDefined();
    runs.push(run!);
    expect(run!.address("participant-a")).toBe(ADDRESS);
    const publications: ReceivingSurfaceFile[][] = [];
    const stop = vi.fn(async () => undefined);
    await run!.attach("participant-a", { allowedOrigins: ["https://example.test"], surface: {
      url: "http://127.0.0.1:8026/inbox", stop,
      publish: async files => {
        // Credentials and mailbox access addresses are registered before desktop publication.
        expect(registered.has(KEY)).toBe(true);
        expect(registered.has(ADDRESS)).toBe(true);
        if (JSON.stringify(files).includes(CODE)) expect(registered.has(CODE)).toBe(true);
        publications.push(structuredClone(files));
      }
    } });
    const finished = await run!.finish();
    expect(finished.participants[0]).toMatchObject({ observed: 1, published: 1, cleanup: "absent" });
    expect(stop).toHaveBeenCalledOnce();
    expect(requests.some(request => request.init.method === "DELETE")).toBe(true);
    const desktop = JSON.stringify(publications);
    expect(desktop).toContain("Synthetic verification code");
    expect(desktop).toContain("data:image/png;base64,");
    expect(desktop).toContain("message-000001");
    for (const authority of [KEY, ACCOUNT, RESOURCE, clientId, MESSAGE, "attachment-fixture-1", "cdn.agentmail.to", "signature=synthetic"]) {
      expect(desktop).not.toContain(authority);
    }
    const retained = await readFile(path.join(runPaths.physicalRunRoot, "comms", "receiving.json"), "utf8");
    expect(JSON.parse(retained)).toEqual(finished);
    const inspection = JSON.stringify(await inspectCommsRecovery({ cwd, stateDir }));
    for (const secret of [KEY, ACCOUNT, RESOURCE, clientId, MESSAGE, ADDRESS, CODE, "Synthetic verification code", "cdn.agentmail.to"]) {
      expect(retained).not.toContain(secret);
      expect(inspection).not.toContain(secret);
    }
    const journalName = (await readdir(stateDir)).find(name => name.endsWith(".json"))!;
    const journal = await readFile(path.join(stateDir, journalName), "utf8");
    expect(journal).toContain(clientId);
    expect(journal).toContain(RESOURCE);
    for (const content of [KEY, CODE, MESSAGE, "Synthetic verification code", "cdn.agentmail.to"]) expect(journal).not.toContain(content);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(stateDir, journalName))).mode & 0o777).toBe(0o600);
    expect(path.relative(cwd, stateDir).startsWith("..")).toBe(true);
    for (const { url, init } of requests) {
      const headers = new Headers(init.headers);
      expect(init.credentials).toBe("omit");
      if (url.origin === "https://api.agentmail.to") expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
      else { expect(headers.get("authorization")).toBeNull(); expect(headers.get("cookie")).toBeNull(); }
    }
  });
});
