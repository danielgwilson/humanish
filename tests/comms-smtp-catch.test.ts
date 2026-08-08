// The catch speaks SMTP as well as HTTP.
//
// Why this exists: most self-hostable apps send mail through SMTP rather than a provider's HTTP API.
// An HTTP-only catch could not study them at all, which is what pushed subject selection toward the
// small set of apps that happen to POST JSON. SMTP is treated as a transport, not a second pipeline
// — a captured message is normalized into the SAME NDJSON line an HTTP send produces, so every
// host-side profile, the inbox surface, and the drain work unchanged.
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SANDBOX_CATCH_SCRIPT, parseDeliveriesNdjson } from "../src/comms-sandbox-catch.js";
import { routeCapturedSends } from "../src/comms-sandbox-catch.js";
import { FakeInbox } from "../src/comms-fake-inbox.js";

/** Drive one SMTP conversation to completion and resolve when the server accepts the message. */
function sendMail(port: number, message: string, envelope: { from: string; to: string }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const replies: string[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () => {});
    const script = [
      "EHLO tester",
      `MAIL FROM:<${envelope.from}>`,
      `RCPT TO:<${envelope.to}>`,
      "DATA",
      `${message}\r\n.`,
      "QUIT"
    ];
    let step = -1;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      replies.push(chunk.trim());
      step += 1;
      if (step < script.length) socket.write(`${script[step]}\r\n`);
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(replies));
    setTimeout(() => {
      socket.destroy();
      reject(new Error("smtp conversation timed out"));
    }, 8000).unref?.();
  });
}

describe("sandbox catch: SMTP transport", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    child?.kill();
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("captures a real SMTP message into the same NDJSON an HTTP send produces", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-smtp-"));
    const scriptPath = path.join(dir, "catch.py");
    const deliveries = path.join(dir, "deliveries.ndjson");
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    const httpPort = 8800 + Math.floor(Math.random() * 100);
    const smtpPort = httpPort + 200;
    child = spawn("python3", [scriptPath, String(httpPort), deliveries, path.join(dir, "surface"), "0", "", String(smtpPort)], {
      stdio: "ignore"
    });

    // Wait for the HTTP side to answer, which means the process is up and the SMTP thread started.
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        up = (await fetch(`http://127.0.0.1:${httpPort}/health`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    expect(up).toBe(true);

    const message = [
      "From: no-reply@example.test",
      "To: ada@example.test",
      "Subject: Verify your email",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="utf-8"',
      "",
      '<p>Welcome!</p><p><a href="https://app.example.test/verify?token=abc123XYZ-9">Confirm</a></p><p>Code: 481920</p>'
    ].join("\r\n");

    const replies = await sendMail(smtpPort, message, { from: "no-reply@example.test", to: "ada@example.test" });
    expect(replies.join(" ")).toContain("220 humanish-comms-catch");
    expect(replies.join(" ")).toContain("250 2.0.0 queued");

    const sends = parseDeliveriesNdjson(await readFile(deliveries, "utf8"));
    expect(sends).toHaveLength(1);
    // Normalized onto the HTTP path, so the existing profiles parse it with no special casing.
    expect(sends[0]!.path).toBe("/emails");
    const body = JSON.parse(sends[0]!.body) as { from: string; to: string[]; subject: string; html: string };
    expect(body.from).toBe("no-reply@example.test");
    expect(body.to).toEqual(["ada@example.test"]);
    expect(body.subject).toBe("Verify your email");
    expect(body.html).toContain("app.example.test/verify?token=abc123XYZ-9");

    // And the whole host-side pipeline consumes it unchanged: routed into an inbox, link extracted.
    const channel = new FakeInbox();
    const inbox = await channel.provisionAddress("lane-01", "ada@example.test");
    await routeCapturedSends(sends, channel);
    const messages = await channel.poll(inbox, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.links.some((l) => l.includes("verify?token=abc123XYZ-9"))).toBe(true);
    expect(messages[0]!.codes).toContain("481920");
  });

  it("does not open an SMTP port unless one was asked for", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-smtp-"));
    const scriptPath = path.join(dir, "catch.py");
    const deliveries = path.join(dir, "deliveries.ndjson");
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    const httpPort = 8600 + Math.floor(Math.random() * 100);
    const smtpPort = httpPort + 150;
    // No SMTP argv: routes that do not need it must not gain an extra listener.
    child = spawn("python3", [scriptPath, String(httpPort), deliveries, path.join(dir, "surface")], { stdio: "ignore" });

    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        up = (await fetch(`http://127.0.0.1:${httpPort}/health`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    expect(up).toBe(true);
    // Nothing is listening on the SMTP port, so a connection is refused outright.
    await expect(
      sendMail(smtpPort, "Subject: x", { from: "no-reply@example.test", to: "ada@example.test" })
    ).rejects.toThrow();
  });
});
