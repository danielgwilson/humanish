// #380: the adopter-hosted catch must render its own inbox.
//
// The regression these pin: `humanish comms catch` created a surface dir, advertised
// "GET /inbox <- the persona opens this", and never wrote a single file into it. In-sandbox,
// humanish-as-host renders that surface on a cadence; on a plane humanish does not provision there is
// no such host, so every persona that reached /inbox got `message not found` from a catch whose
// /health was green. The funnel dead-ended at a technically-healthy service, which is the worst shape
// a failure can take — it looks like working infrastructure.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderInboxSurfaceLocally } from "../src/comms-catch-host.js";
import { withFreePort } from "./helpers/free-port.js";
import {
  SANDBOX_CATCH_SCRIPT,
  capturedRecipientAddresses,
  parseDeliveriesNdjson
} from "../src/comms-sandbox-catch.js";

const VERIFY_HTML =
  '<p>Confirm your account.</p><p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify</a></p><p>Code: <b>481920</b></p>';

function sendLine(to: string[], subject: string, html: string): string {
  return JSON.stringify({
    t: 1,
    path: "/emails",
    body: JSON.stringify({ from: "no-reply@example.test", to, subject, html })
  });
}

describe("parseDeliveriesNdjson", () => {
  it("drops a trailing PARTIAL line (a reader racing an append) and skips malformed lines", () => {
    const complete = sendLine(["a@example.test"], "One", "<p>hi</p>");
    // No trailing newline: the last line may be half-written, so it must not be parsed yet.
    const sends = parseDeliveriesNdjson(`${complete}\n{"path":"/emails","bo`);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.path).toBe("/emails");

    // With the newline present, the same line is complete and IS parsed.
    expect(parseDeliveriesNdjson(`${complete}\n`)).toHaveLength(1);
    // A malformed complete line is skipped rather than throwing.
    expect(parseDeliveriesNdjson(`not json\n${complete}\n`)).toHaveLength(1);
    expect(parseDeliveriesNdjson("")).toEqual([]);
  });
});

describe("capturedRecipientAddresses", () => {
  it("discovers the distinct addresses the app actually mailed, across profiles", () => {
    const sends = parseDeliveriesNdjson(
      [
        sendLine(["ada@example.test"], "One", "<p>a</p>"),
        sendLine(["ada@example.test", "grace@example.test"], "Two", "<p>b</p>"),
        JSON.stringify({
          t: 3,
          path: "/v3/mail/send",
          body: JSON.stringify({
            from: { email: "no-reply@example.test" },
            personalizations: [{ to: [{ email: "hopper@example.test" }] }],
            content: [{ type: "text/html", value: "<p>c</p>" }]
          })
        })
      ].join("\n") + "\n"
    );
    expect(capturedRecipientAddresses(sends).sort()).toEqual([
      "ada@example.test",
      "grace@example.test",
      "hopper@example.test"
    ]);
  });
});

describe("renderInboxSurfaceLocally (the adopter-hosted plane)", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("renders an EMPTY inbox when no mail has been captured, so /inbox is never a bare 404", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-host-"));
    const surfaceDir = path.join(dir, "surface");
    // Deliberately NO deliveries file: this is the state a freshly started catch is in.
    const result = await renderInboxSurfaceLocally({
      deliveriesPath: path.join(dir, "deliveries.ndjson"),
      surfaceDir
    });
    expect(result.sends).toBe(0);
    expect(result.files).toBeGreaterThan(0);

    const page = await readFile(path.join(surfaceDir, "inbox", "index"), "utf8");
    // The distinction the adopter asked for: an empty mailbox must not read as a broken one.
    expect(page).toContain("No messages yet");
    expect(page).not.toContain("message not found");
    expect(JSON.parse(await readFile(path.join(surfaceDir, "api", "inbox", "index"), "utf8"))).toEqual([]);
  });

  it("renders captured mail with the verify link and OTP, discovering the recipient from the mail itself", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-host-"));
    const surfaceDir = path.join(dir, "surface");
    const deliveriesPath = path.join(dir, "deliveries.ndjson");
    await writeFile(deliveriesPath, sendLine(["ada@example.test"], "Verify your email", VERIFY_HTML) + "\n", "utf8");

    // No recipients passed: a standalone catch has no lab roster to read them from.
    const result = await renderInboxSurfaceLocally({ deliveriesPath, surfaceDir });
    expect(result.sends).toBe(1);
    expect(result.messages).toBe(1);

    const list = await readFile(path.join(surfaceDir, "inbox", "index"), "utf8");
    expect(list).toContain("Verify your email");
    expect(list).not.toContain("No messages yet");

    const json = JSON.parse(await readFile(path.join(surfaceDir, "api", "inbox", "index"), "utf8")) as Array<{
      id: string;
      verifyUrl?: string;
      otp?: string;
    }>;
    expect(json).toHaveLength(1);
    expect(json[0]!.verifyUrl).toBe("https://app.example.test/verify?token=abc123XYZ-9");
    expect(json[0]!.otp).toBe("481920");

    // The persona opens the message itself and must find the link there too.
    const detail = await readFile(path.join(surfaceDir, "inbox", json[0]!.id, "index"), "utf8");
    expect(detail).toContain("https://app.example.test/verify?token=abc123XYZ-9");
  });

  it("is idempotent: re-rendering the same deliveries never duplicates a message", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-host-"));
    const surfaceDir = path.join(dir, "surface");
    const deliveriesPath = path.join(dir, "deliveries.ndjson");
    await writeFile(deliveriesPath, sendLine(["ada@example.test"], "Verify", VERIFY_HTML) + "\n", "utf8");

    await renderInboxSurfaceLocally({ deliveriesPath, surfaceDir });
    const second = await renderInboxSurfaceLocally({ deliveriesPath, surfaceDir });
    expect(second.messages).toBe(1);
    expect(JSON.parse(await readFile(path.join(surfaceDir, "api", "inbox", "index"), "utf8"))).toHaveLength(1);
  });

  it("--recipient scopes the rendered inbox to the named address", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-host-"));
    const surfaceDir = path.join(dir, "surface");
    const deliveriesPath = path.join(dir, "deliveries.ndjson");
    await writeFile(
      deliveriesPath,
      [
        sendLine(["ada@example.test"], "For Ada", VERIFY_HTML),
        sendLine(["grace@example.test"], "For Grace", VERIFY_HTML)
      ].join("\n") + "\n",
      "utf8"
    );

    const scoped = await renderInboxSurfaceLocally({
      deliveriesPath,
      surfaceDir,
      recipients: ["ada@example.test"]
    });
    expect(scoped.messages).toBe(1);
    const list = await readFile(path.join(surfaceDir, "inbox", "index"), "utf8");
    expect(list).toContain("For Ada");
    expect(list).not.toContain("For Grace");
  });
});

describe("catch script: persona-facing routes (#380)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    child?.kill();
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("GET / points at the inbox, /health keeps the machine marker, and a missing /api message answers in JSON", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-routes-"));
    const scriptPath = path.join(dir, "catch.py");
    const surfaceDir = path.join(dir, "surface");
    await mkdir(surfaceDir, { recursive: true });
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    // A free port from the OS, retried if the child loses a race for it. The old
    // `8700 + random(200)` was ALSO used by comms-sandbox-catch.test.ts, so two vitest workers
    // could hand the same port to two servers; the loser exited and this test waited out a health
    // loop that could never succeed. See tests/helpers/free-port.ts.
    // Resolved before the closure: `dir` is nullable at this scope and TypeScript cannot narrow it
    // through an async callback.
    const deliveriesPath = path.join(dir, "deliveries.ndjson");
    const port = await withFreePort(async (candidate) => {
      child = spawn("python3", [scriptPath, String(candidate), deliveriesPath, surfaceDir], {
        stdio: "ignore"
      });
      // Sleep on EVERY failed attempt, not only on a thrown one: a non-ok response used to retry
      // instantly, burning all 50 attempts inside a few milliseconds.
      for (let i = 0; i < 50; i += 1) {
        try {
          if ((await fetch(`http://127.0.0.1:${candidate}/health`)).ok) return true;
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      child?.kill();
      return false;
    });

    const base = `http://127.0.0.1:${port}`;

    // /health is what BOTH readiness probes assert on, so its shape must not move.
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, service: "humanish-comms-catch" });

    // GET / used to return that same health JSON, which personas who trimmed the /inbox path read as
    // breakage. It now points them where they meant to go.
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("/inbox");

    // A JSON route answers in JSON, not HTML.
    const missingApi = await fetch(`${base}/api/inbox/nope`);
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("content-type")).toContain("application/json");
    expect(await missingApi.json()).toEqual({ error: "message not found" });
  });
});
