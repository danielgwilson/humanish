import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeInbox } from "../src/comms-fake-inbox.js";
import { buildCommsThreadArtifact } from "../src/comms-evidence.js";
import { buildInboxSurface } from "../src/comms-inbox.js";
import {
  SANDBOX_CATCH_SCRIPT,
  collectCommsThread,
  deployCommsCatch,
  drainCommsCatch,
  refreshInboxSurface,
  routeCapturedSends,
  type RawCapturedSend
} from "../src/comms-sandbox-catch.js";
import type { E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";

const VERIFICATION_HTML =
  '<p>Confirm your account.</p><p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify</a></p><p>Code: <b>481920</b></p>';

// ---------------------------------------------------------------- fake E2B desktop
function makeFakeDesktop(handler: (cmd: string) => { stdout?: string; exitCode?: number } | undefined): {
  desktop: E2BDesktopSandbox;
  calls: Array<[string, ...unknown[]]>;
  files: Record<string, string>;
} {
  const calls: Array<[string, ...unknown[]]> = [];
  const files: Record<string, string> = {};
  const desktop = {
    commands: {
      run: async (cmd: string) => {
        calls.push(["run", cmd]);
        return handler(cmd) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: {
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["write", filePath, data]);
        files[filePath] = String(data);
      }
    }
  };
  return { desktop: desktop as unknown as E2BDesktopSandbox, calls, files };
}

const instantTimers = { now: () => 0, sleep: async () => {} };

describe("comms-sandbox-catch: the in-sandbox capture SCRIPT (run for real, no E2B)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    child?.kill("SIGKILL");
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("captures each POST as an NDJSON line and returns a plausible provider success", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-"));
    const scriptPath = path.join(dir, "catch.py");
    const deliveries = path.join(dir, "deliveries.ndjson");
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    const port = 8300 + Math.floor(Math.random() * 400);
    child = spawn("python3", [scriptPath, String(port), deliveries], { stdio: "ignore" });

    // wait for /health
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 60)); }
    }
    expect(up).toBe(true);

    // Resend flat shape → 200 { id }
    const flat = await fetch(`${base}/emails`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "no-reply@example.test", to: ["patient-07@example.test"], subject: "Confirm", html: VERIFICATION_HTML })
    });
    expect(flat.status).toBe(200);
    expect((await flat.json() as { id: string }).id).toContain("humanish-catch-");

    // SendGrid path → 202 + x-message-id
    const sg = await fetch(`${base}/v3/mail/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { email: "a@example.test" }, personalizations: [{ to: [{ email: "p@example.test" }] }], content: [{ type: "text/html", value: "hi" }] })
    });
    expect(sg.status).toBe(202);
    expect(sg.headers.get("x-message-id")).toBeTruthy();

    // Both were appended as NDJSON lines with {path, body}.
    const lines = (await readFile(deliveries, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { path: string; body: string };
    expect(first.path).toBe("/emails");
    expect(JSON.parse(first.body).subject).toBe("Confirm");
    expect(JSON.parse(lines[1]!).path).toBe("/v3/mail/send");
  });

  it("with an inbox port: a 0.0.0.0 read-only listener serves GET /inbox but rejects POST; capture stays loopback", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-"));
    const scriptPath = path.join(dir, "catch.py");
    const deliveries = path.join(dir, "deliveries.ndjson");
    const surfaceDir = path.join(dir, "surface");
    await mkdir(path.join(surfaceDir, "inbox"), { recursive: true });
    await writeFile(path.join(surfaceDir, "inbox", "index"), "<h1>INBOX OK</h1>", "utf8");
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    const port = 8500 + Math.floor(Math.random() * 200);
    const inboxPort = port + 1;
    child = spawn("python3", [scriptPath, String(port), deliveries, surfaceDir, String(inboxPort)], { stdio: "ignore" });

    const upBoth = async (): Promise<boolean> => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok && (await fetch(`http://127.0.0.1:${inboxPort}/health`)).ok; }
      catch { return false; }
    };
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) { up = await upBoth(); if (!up) await new Promise((r) => setTimeout(r, 60)); }
    expect(up).toBe(true);

    // The 0.0.0.0 inbox listener serves the surface (GET)…
    const g = await fetch(`http://127.0.0.1:${inboxPort}/inbox`);
    expect(g.status).toBe(200);
    expect(await g.text()).toContain("INBOX OK");
    // …but rejects capture POSTs (read-only — nothing on the internet can inject a fake send).
    expect((await fetch(`http://127.0.0.1:${inboxPort}/emails`, { method: "POST", body: "x" })).status).toBe(405);
    // The loopback capture listener still captures.
    const captured = await fetch(`http://127.0.0.1:${port}/emails`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: ["p@example.test"] })
    });
    expect(captured.status).toBe(200);
    expect((await readFile(deliveries, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("comms-sandbox-catch: deploy / drain / route over the E2B interface (fake desktop)", () => {
  it("deployCommsCatch writes the script + launches it detached + probes ready", async () => {
    const { desktop, calls, files } = makeFakeDesktop((cmd) => (cmd.includes("curl") ? { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" } : undefined));
    const deployed = await deployCommsCatch(desktop, { port: 8025, timers: instantTimers });

    expect(deployed.baseUrl).toBe("http://127.0.0.1:8025"); // inject THIS as the app's email-API base URL
    expect(deployed.ready).toBe(true);
    // The self-contained capture script was written into the sandbox…
    const written = Object.entries(files).find(([p]) => p.endsWith("catch.py"));
    expect(written?.[1]).toContain('ThreadingHTTPServer');
    // …and launched detached (setsid) with the fixed port + deliveries path.
    expect(calls.some(([, c]) => typeof c === "string" && c.includes("setsid -f") && c.includes("comms-catch"))).toBe(true);
    // …and probed for readiness on /health.
    expect(calls.some(([, c]) => typeof c === "string" && c.includes("curl") && c.includes("8025/health"))).toBe(true);
  });

  it("deployCommsCatch with an inboxPort passes it as the 4th arg, probes BOTH listeners, and returns it", async () => {
    const { desktop, calls, files } = makeFakeDesktop((cmd) => (cmd.includes("curl") ? { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" } : undefined));
    const deployed = await deployCommsCatch(desktop, { port: 8025, inboxPort: 8026, timers: instantTimers });

    expect(deployed.ready).toBe(true);
    expect(deployed.inboxPort).toBe(8026);
    // launched with the inbox port as the 4th arg (the launch command lives in the wrapper run.sh file)…
    expect(Object.values(files).some((v) => v.includes("catch.py") && v.includes(" 8026"))).toBe(true);
    // …and BOTH listeners were probed for readiness (a dead inbox listener would 502 via getHost).
    expect(calls.some(([, c]) => typeof c === "string" && c.includes("8025/health"))).toBe(true);
    expect(calls.some(([, c]) => typeof c === "string" && c.includes("8026/health"))).toBe(true);
  });

  it("deployCommsCatch rejects an inboxPort equal to the capture port", async () => {
    const { desktop } = makeFakeDesktop((cmd) => (cmd.includes("curl") ? { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" } : undefined));
    await expect(deployCommsCatch(desktop, { port: 8025, inboxPort: 8025, timers: instantTimers })).rejects.toThrow(/invalid inboxPort/);
  });

  it("drainCommsCatch reads new NDJSON lines since a cursor (incremental)", async () => {
    let ndjson = JSON.stringify({ t: 1, path: "/emails", body: '{"to":["a@example.test"]}' }) + "\n";
    const { desktop } = makeFakeDesktop((cmd) => (cmd.startsWith("cat ") ? { stdout: ndjson } : undefined));
    const deployed = { deliveriesPath: "/tmp/humanish-comms/deliveries.ndjson" };

    const first = await drainCommsCatch(desktop, deployed, 0);
    expect(first.sends).toHaveLength(1);
    expect(first.cursor).toBe(1);
    expect(first.sends[0]!.path).toBe("/emails");

    // A second send appears; draining from the prior cursor yields ONLY the new one.
    ndjson += JSON.stringify({ t: 2, path: "/v3/mail/send", body: "{}" }) + "\n";
    const second = await drainCommsCatch(desktop, deployed, first.cursor);
    expect(second.sends).toHaveLength(1);
    expect(second.sends[0]!.path).toBe("/v3/mail/send");
    expect(second.cursor).toBe(2);
  });

  it("routeCapturedSends parses drained raw sends with the profiles and delivers into the inbox", async () => {
    const bus = new FakeInbox();
    const patient = await bus.provision("patient-07");
    const sends: RawCapturedSend[] = [
      { t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: [patient.value], subject: "Confirm", html: VERIFICATION_HTML }) },
      { t: 2, path: "/v3/mail/send", body: JSON.stringify({ from: { email: "a@example.test" }, personalizations: [{ to: [{ email: patient.value }] }], content: [{ type: "text/html", value: "Code 903117 <a href=\"https://x.example.test/y\">go</a>" }] }) }
    ];
    const delivered = await routeCapturedSends(sends, bus);
    expect(delivered).toBe(2);

    const inbox = await bus.poll(patient);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]!.links).toEqual(["https://app.example.test/verify?token=abc123XYZ-9"]);
    expect(inbox[0]!.codes).toEqual(["481920"]);
    expect(inbox[1]!.codes).toEqual(["903117"]); // the SendGrid-shape send routed through the SAME path
  });

  it("end-to-end (fake sandbox): deploy → app sends captured to NDJSON → drain → route → inbox", async () => {
    const bus = new FakeInbox();
    const patient = await bus.provision("patient-07");
    // The fake sandbox: /health READY, and cat returns the NDJSON the (simulated) app's POST produced.
    const captured = JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: [patient.value], subject: "Confirm", html: VERIFICATION_HTML }) }) + "\n";
    const { desktop } = makeFakeDesktop((cmd) => {
      if (cmd.includes("curl")) return { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" };
      if (cmd.startsWith("cat ")) return { stdout: captured };
      return undefined;
    });
    const deployed = await deployCommsCatch(desktop, { timers: instantTimers });
    const { sends } = await drainCommsCatch(desktop, deployed);
    await routeCapturedSends(sends, bus);

    const inbox = await bus.poll(patient);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.links).toEqual(["https://app.example.test/verify?token=abc123XYZ-9"]);
    expect(inbox[0]!.codes).toEqual(["481920"]);
  });
});

describe("comms-sandbox-catch: collectCommsThread (whole-run evidence collect)", () => {
  it("drains → routes to declared recipients → builds the digest-only thread artifact (no raw PII)", async () => {
    const channel = new FakeInbox();
    const patient = await channel.provisionAddress("patient", "patient@example.test");
    const captured =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: [patient.value], subject: "Confirm your email", html: VERIFICATION_HTML }) }) + "\n";
    const { desktop } = makeFakeDesktop((cmd) => {
      if (cmd.includes("curl")) return { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" };
      if (cmd.startsWith("cat ")) return { stdout: captured };
      return undefined;
    });
    const deployed = await deployCommsCatch(desktop, { timers: instantTimers });

    const collected = await collectCommsThread({ desktop, deployed, channel, inboxes: [patient] });
    expect(collected.captured).toBe(1);
    expect(collected.matched).toBe(1);
    const artifact = collected.artifact;
    expect(artifact).toBeDefined();
    expect(artifact!.schema).toBe("humanish.comms-thread.v1");
    expect(artifact!.count).toBe(1);
    const entry = artifact!.thread[0]!;
    expect(entry.toDigests[0]).toBe(patient.digest);
    expect(entry.linkDigests[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.codeCount).toBe(1);
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain("patient@example.test");
    expect(serialized).not.toContain("app.example.test/verify");
    expect(serialized).not.toContain("481920");
    expect(serialized).not.toContain("Confirm your email");
  });

  it("returns undefined when nothing was captured, and when captured mail matches no provisioned inbox (no false evidence)", async () => {
    const channel = new FakeInbox();
    const patient = await channel.provisionAddress("patient", "patient@example.test");

    const empty = makeFakeDesktop((cmd) => {
      if (cmd.includes("curl")) return { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" };
      if (cmd.startsWith("cat ")) return { stdout: "" };
      return undefined;
    });
    const deployedEmpty = await deployCommsCatch(empty.desktop, { timers: instantTimers });
    const emptyCollected = await collectCommsThread({ desktop: empty.desktop, deployed: deployedEmpty, channel, inboxes: [patient] });
    expect(emptyCollected.artifact).toBeUndefined();
    expect(emptyCollected.captured).toBe(0); // nothing captured at all

    // Captured mail addressed to an UNPROVISIONED inbox is dropped by deliverRaw → no artifact, but
    // it WAS captured (matched 0) — the caller warns rather than losing it silently.
    const stranger =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "x@example.test", to: ["stranger@example.test"], subject: "hi", html: "<p>hi</p>" }) }) + "\n";
    const other = makeFakeDesktop((cmd) => {
      if (cmd.includes("curl")) return { stdout: "{\"ok\":true,\"service\":\"humanish-comms-catch\"}" };
      if (cmd.startsWith("cat ")) return { stdout: stranger };
      return undefined;
    });
    const deployedOther = await deployCommsCatch(other.desktop, { timers: instantTimers });
    const strangerCollected = await collectCommsThread({ desktop: other.desktop, deployed: deployedOther, channel, inboxes: [patient] });
    expect(strangerCollected.artifact).toBeUndefined();
    expect(strangerCollected.captured).toBe(1); // captured but unmatched → caller surfaces a warning
    expect(strangerCollected.matched).toBe(0);
  });
});

describe("comms-sandbox-catch: refreshInboxSurface (mid-run full rebuild)", () => {
  const recipients = [{ lane: "patient", address: "patient-07@example.test" }];
  const captured =
    JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: ["patient-07@example.test"], subject: "Confirm", html: VERIFICATION_HTML }) }) + "\n";

  it("rebuilds from the full NDJSON, renders on new mail, and skips a render when nothing new arrived", async () => {
    const nd = { value: "" };
    const { desktop, files } = makeFakeDesktop((cmd) => (cmd.startsWith("cat ") ? { stdout: nd.value } : undefined));
    const deployed = { deliveriesPath: "/tmp/x/deliveries.ndjson", surfaceDir: "/tmp/x/surface" };

    // Empty catch → no render.
    let r = await refreshInboxSurface({ desktop, deployed, recipients });
    expect(r).toEqual({ count: 0, rendered: false });
    expect(Object.keys(files)).toHaveLength(0);

    // Mail arrives → render; the served files were written into the surface dir.
    nd.value = captured;
    r = await refreshInboxSurface({ desktop, deployed, recipients, sinceCount: 0 });
    expect(r).toEqual({ count: 1, rendered: true });
    expect(Object.keys(files)).toContain("/tmp/x/surface/inbox/index");
    expect(Object.keys(files)).toContain("/tmp/x/surface/api/inbox/latest");

    // Nothing new since the last successful render (sinceCount === current count) → skip (cheap idle tick).
    const before = Object.keys(files).length;
    r = await refreshInboxSurface({ desktop, deployed, recipients, sinceCount: 1 });
    expect(r).toEqual({ count: 1, rendered: false });
    expect(Object.keys(files).length).toBe(before);
  });

  it("is idempotent + retry-safe: a rebuild after a transient render failure does NOT duplicate messages", async () => {
    const nd = { value: captured };
    let failNextWrite = true;
    // A desktop whose FIRST files.write of the message index throws (transient), then succeeds.
    const calls: Array<[string, ...unknown[]]> = [];
    const files: Record<string, string> = {};
    const desktop = {
      commands: { run: async (cmd: string) => { calls.push(["run", cmd]); return cmd.startsWith("cat ") ? { stdout: nd.value } : { exitCode: 0, stdout: "" }; } },
      files: {
        write: async (filePath: string, data: string | ArrayBuffer) => {
          if (failNextWrite && filePath.endsWith("/inbox/index")) { failNextWrite = false; throw new Error("transient files.write timeout"); }
          files[filePath] = String(data);
        }
      }
    } as unknown as E2BDesktopSandbox;
    const deployed = { deliveriesPath: "/tmp/x/deliveries.ndjson", surfaceDir: "/tmp/x/surface" };

    // First refresh throws mid-render (surface partially/not written); count is NOT advanced by the caller.
    await expect(refreshInboxSurface({ desktop, deployed, recipients, sinceCount: 0 })).rejects.toThrow();
    // Retry (sinceCount still 0, because the caller only advances on rendered:true) rebuilds cleanly.
    const r = await refreshInboxSurface({ desktop, deployed, recipients, sinceCount: 0 });
    expect(r).toEqual({ count: 1, rendered: true });
    // Exactly ONE message rendered — the retry rebuilt from a fresh channel, so no duplicate.
    const list = JSON.parse(files["/tmp/x/surface/api/inbox/index"]!) as unknown[];
    expect(list).toHaveLength(1);
  });
});

describe("comms-sandbox-catch: serves the host-rendered inbox SURFACE (script run for real)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    child?.kill("SIGKILL");
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("GET /inbox, /inbox/latest, /api/inbox/latest serve the rendered files; missing → 404; traversal → 400", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-catch-"));
    const scriptPath = path.join(dir, "catch.py");
    const deliveries = path.join(dir, "deliveries.ndjson");
    const surfaceDir = path.join(dir, "surface");
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");

    // Host-render (typed) the surface for one captured verification email with an app-LOOPBACK verify
    // link, then write the files into surfaceDir exactly as the real host bridge (writeInboxSurface) does.
    const loopbackEmail = '<p>Hi.</p><p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify</a></p><p>Code: <b>481920</b></p>';
    const bus = new FakeInbox();
    const patient = await bus.provisionAddress("patient", "patient-07@example.test");
    await bus.deliverRaw({ from: "no-reply@example.test", to: [patient.value], subject: "Confirm your email", body: loopbackEmail });
    const messages = await bus.poll(patient);
    const files = buildInboxSurface(messages, { originMap: [["http://127.0.0.1:3000", "https://3000-abc.e2b.app"]] });
    for (const file of files) {
      const full = path.join(surfaceDir, file.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.body, "utf8");
    }

    const port = 8700 + Math.floor(Math.random() * 200);
    child = spawn("python3", [scriptPath, String(port), deliveries, surfaceDir], { stdio: "ignore" });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 60)); }
    }
    expect(up).toBe(true);

    // The persona opens the inbox list…
    const list = await fetch(`${base}/inbox`);
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toContain("text/html");
    // The surface page carries a browser-enforced, script-forbidding CSP (renders untrusted email HTML).
    expect(list.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(await list.text()).toContain("Confirm your email");

    // …and the latest message: the app's real email, its verify link origin-rewritten to a reachable host.
    const latest = await fetch(`${base}/inbox/latest`);
    expect(latest.status).toBe(200);
    const latestHtml = await latest.text();
    expect(latestHtml).toContain("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
    expect(latestHtml).not.toContain("http://127.0.0.1:3000/verify");

    // A programmatic actor hits the JSON twin instead.
    const apiLatest = await fetch(`${base}/api/inbox/latest`);
    expect(apiLatest.status).toBe(200);
    expect(apiLatest.headers.get("content-type")).toContain("application/json");
    const json = await apiLatest.json() as { verifyUrl: string; otp: string; to: string[] };
    expect(json.verifyUrl).toBe("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
    expect(json.otp).toBe("481920");
    expect(json.to).toEqual(["patient-07@example.test"]);

    // Missing message → 404; a path-traversal attempt is rejected before any read.
    expect((await fetch(`${base}/inbox/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/inbox/..%2f..%2f..%2fetc%2fpasswd`)).status).toBe(400);
  });
});

describe("comms-evidence: digest-only comms-thread artifact", () => {
  it("digests addresses + links, redacts the subject, and stores the OTP as a COUNT (never a reversible digest)", async () => {
    const bus = new FakeInbox();
    const patient = await bus.provision("patient-07");
    await bus.deliverRaw({ from: "no-reply@example.test", to: [patient.value], subject: "Confirm your email", body: VERIFICATION_HTML });
    const messages = await bus.poll(patient);

    const artifact = buildCommsThreadArtifact(messages);
    expect(artifact.schema).toBe("humanish.comms-thread.v1");
    expect(artifact.count).toBe(1);
    const entry = artifact.thread[0]!;
    expect(entry.fromDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.toDigests[0]).toBe(patient.digest);
    expect(entry.linkDigests[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.subjectDigest).toMatch(/^[0-9a-f]{16}$/); // subject digested, never stored as text
    expect(entry.codeCount).toBe(1); // count only — the OTP "481920" itself is NOT stored

    // Hygiene: the serialized artifact leaks neither the raw address, the raw link, the OTP code, nor the raw subject.
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain("patient-07@example.test");
    expect(serialized).not.toContain("app.example.test/verify");
    expect(serialized).not.toContain("481920");
    expect(serialized).not.toContain("Confirm your email");
  });
});
