import { afterEach, describe, expect, it } from "vitest";

import { FakeInbox, extractLinks, extractOtpCodes } from "../src/comms-fake-inbox.js";
import { startEmailCatchServer, type EmailCatchServer } from "../src/comms-email-catch.js";

// A realistic patient-signup verification email (magic link + OTP) — the exact thing the north-star
// use case needs. Used across the extraction + end-to-end tests. No external app/repo involved.
const VERIFICATION_HTML = [
  "<html><body>",
  "<h1>Welcome to Example Health</h1>",
  "<p>Confirm your email address to finish creating your patient account.</p>",
  '<p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify my email</a></p>',
  "<p>Or enter this verification code: <b>481920</b></p>",
  "<p style='color:#999'>If you did not request this, ignore this message. (ref 2026)</p>",
  "</body></html>"
].join("");

describe("comms extraction (magic link + OTP from a verification email)", () => {
  it("extractLinks pulls the actionable https link (href + bare), de-duped", () => {
    expect(extractLinks(VERIFICATION_HTML)).toEqual(["https://app.example.test/verify?token=abc123XYZ-9"]);
    expect(extractLinks("plain text with https://x.test/a and https://x.test/a again")).toEqual(["https://x.test/a"]);
    expect(extractLinks("no links here")).toEqual([]);
    expect(extractLinks("")).toEqual([]);
  });

  it("extractOtpCodes prefers the LABELED code and ignores incidental numbers (e.g. the year)", () => {
    // "verification code: 481920" is labeled → returned; the "(ref 2026)" year is NOT a labeled code.
    expect(extractOtpCodes(VERIFICATION_HTML)).toEqual(["481920"]);
    expect(extractOtpCodes("Your one-time passcode is 8A3F2K.")).toEqual(["8A3F2K"]);
    expect(extractOtpCodes("Your OTP: 4821")).toEqual(["4821"]);
  });

  it("extractOtpCodes falls back to an isolated digit run only when nothing is labeled", () => {
    expect(extractOtpCodes("Use 552113 to continue.")).toEqual(["552113"]); // bare fallback
    expect(extractOtpCodes("Order #7 total $12 shipped")).toEqual([]); // no 4-8 digit isolated run
  });

  it("extractOtpCodes does not capture a labeled prose WORD (no digit) as a code", () => {
    expect(extractOtpCodes("Your code is INVALID.")).toEqual([]); // "INVALID" has no digit → not a code
    expect(extractOtpCodes("verification code AB12CD")).toEqual(["AB12CD"]); // alphanumeric WITH a digit is fine
  });
});

describe("FakeInbox (the in-process bus)", () => {
  it("provisions a stable, digest-bearing address per actor (raw value stays separate from the digest)", async () => {
    const bus = new FakeInbox({ now: () => 1000 });
    const a = await bus.provision("patient-07");
    expect(a.value).toBe("patient-07@example.test");
    expect(a.channel).toBe("email");
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(a.digest).not.toContain("patient-07"); // the digest is the only persist-safe form
    expect(await bus.provision("patient-07")).toEqual(a); // idempotent per actor
  });

  it("provisionAddress registers an explicit declared recipient address (idempotent by value) that deliverRaw resolves", async () => {
    const bus = new FakeInbox();
    // A declared local part distinct from what provision("patient") would auto-generate — proving an
    // ARBITRARY declared address is honored (not just the default actor-id-keyed one).
    const a = await bus.provisionAddress("patient", "patient-07@example.test");
    expect(a.value).toBe("patient-07@example.test");
    expect(a.actorId).toBe("patient");
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
    // Idempotent by value (case-insensitive): re-declaring returns the SAME inbox (never resets its queue).
    await bus.deliverRaw({ from: "no-reply@example.test", to: ["patient-07@example.test"], subject: "hi", body: "<a href=\"https://app.example.test/verify?t=1\">v</a>" });
    const again = await bus.provisionAddress("patient", "PATIENT-07@example.test");
    expect(again.value).toBe("patient-07@example.test");
    expect(await bus.poll(again)).toHaveLength(1); // queue preserved across the idempotent re-declare
    // The app's send to a DIFFERENT address is dropped (only the declared literal resolves).
    expect(await bus.deliverRaw({ from: "no-reply@example.test", to: ["someone-else@example.test"], body: "hi" })).toHaveLength(0);
  });

  it("routes an INGRESS delivery to the addressed inbox and extracts link + code; poll is since-scoped", async () => {
    let clock = 100;
    const bus = new FakeInbox({ now: () => clock });
    const patient = await bus.provision("patient-07");

    clock = 200;
    const delivered = await bus.deliverRaw({
      from: "Example Health <no-reply@example.test>",
      to: [patient.value],
      subject: "Confirm your email",
      body: VERIFICATION_HTML
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to.map((t) => t.actorId)).toEqual(["patient-07"]);
    expect(delivered[0]!.links).toEqual(["https://app.example.test/verify?token=abc123XYZ-9"]);
    expect(delivered[0]!.codes).toEqual(["481920"]);

    // The persona polls its inbox and sees the new message.
    expect(await bus.poll(patient)).toHaveLength(1);
    // …but not messages at-or-before a `since` boundary.
    expect(await bus.poll(patient, 200)).toHaveLength(0);
    expect(await bus.poll(patient, 199)).toHaveLength(1);
  });

  it("drops a delivery to an unprovisioned recipient (no inbox to deliver to); broadcast hits all matched", async () => {
    const bus = new FakeInbox();
    const p2 = await bus.provision("player-2");
    const p3 = await bus.provision("player-3");
    expect(await bus.deliverRaw({ from: "app", to: ["nobody@example.test"], body: "hi" })).toEqual([]);
    const [msg] = await bus.deliverRaw({ from: "host@example.test", to: [p2.value, p3.value], body: "join https://app.test/lobby/ABC123" });
    expect(msg!.to.map((t) => t.actorId).sort()).toEqual(["player-2", "player-3"]);
    expect((await bus.poll(p2))[0]!.links).toEqual(["https://app.test/lobby/ABC123"]);
    expect(await bus.poll(p3)).toHaveLength(1);
  });

  it("send() routes an actor->actor message; teardown() clears the world", async () => {
    const bus = new FakeInbox();
    const a = await bus.provision("a");
    const b = await bus.provision("b");
    await bus.send({ from: a, to: [b], subject: "hi", body: "see https://x.test/y" });
    expect(await bus.poll(b)).toHaveLength(1);
    await bus.teardown();
    expect(bus.addresses()).toEqual([]);
    expect(await bus.poll(b)).toHaveLength(0);
  });
});

describe("end-to-end: a vendor-neutral email-API catch delivers an app's send into the fake inbox (no external app/repo)", () => {
  let server: EmailCatchServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("captures a flat-shape (Resend-compatible) verification email via POST /emails and delivers it", async () => {
    const bus = new FakeInbox();
    const patient = await bus.provision("patient-07");
    server = await startEmailCatchServer(bus, { idFor: (n) => `test-${n}` });

    // Exactly what an app does when its email-API base URL is pointed at us via one env var: a
    // POST /emails with the common flat body shape (which Resend uses). No SDK dep — byte-identical.
    const res = await fetch(`${server.url}/emails`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy-api-key" },
      body: JSON.stringify({
        from: "Example Health <no-reply@example.test>",
        to: [patient.value],
        subject: "Confirm your email",
        html: VERIFICATION_HTML
      })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "test-1" });

    const inbox = await bus.poll(patient);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.from).toContain("example.test");
    expect(inbox[0]!.subject).toBe("Confirm your email");
    expect(inbox[0]!.links).toEqual(["https://app.example.test/verify?token=abc123XYZ-9"]);
    expect(inbox[0]!.codes).toEqual(["481920"]);
    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.to).toEqual([patient.value]);
  });

  it("is genuinely vendor-neutral: the SAME server also captures SendGrid's nested POST /v3/mail/send shape", async () => {
    const bus = new FakeInbox();
    const patient = await bus.provision("patient-08");
    server = await startEmailCatchServer(bus);

    // A structurally DIFFERENT wire shape (nested personalizations + typed content) — not a rename.
    const res = await fetch(`${server.url}/v3/mail/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: { email: "no-reply@example.test", name: "Example Health" },
        subject: "Confirm your email",
        personalizations: [{ to: [{ email: patient.value, name: "Patient Eight" }] }],
        content: [
          { type: "text/plain", value: "code 903117" },
          { type: "text/html", value: VERIFICATION_HTML }
        ]
      })
    });
    expect(res.status).toBe(202); // SendGrid-faithful response
    expect(res.headers.get("x-message-id")).toBeTruthy();

    const inbox = await bus.poll(patient);
    expect(inbox).toHaveLength(1);
    // The HTML content part was chosen over text/plain → the magic link + code come from the HTML.
    expect(inbox[0]!.links).toEqual(["https://app.example.test/verify?token=abc123XYZ-9"]);
    expect(inbox[0]!.codes).toEqual(["481920"]);
  });

  it("resolves a 'Name <email>' recipient, handles the batch endpoint, and 404s unknown paths", async () => {
    const bus = new FakeInbox();
    const patient = await bus.provision("patient-09");
    server = await startEmailCatchServer(bus);

    const health = await fetch(`${server.url}/health`);
    const body = await health.json() as { ok: boolean; profiles: string[] };
    expect(body.ok).toBe(true);
    expect(body.profiles).toContain("generic");
    expect(body.profiles).toContain("sendgrid");

    const batch = await fetch(`${server.url}/emails/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { from: "app", to: [`Patient Nine <${patient.value}>`], subject: "code", html: "Your code is 771002" }
      ])
    });
    expect(batch.status).toBe(200);
    expect((await batch.json() as { data: unknown[] }).data).toHaveLength(1);
    expect((await bus.poll(patient))[0]!.codes).toEqual(["771002"]);

    expect((await fetch(`${server.url}/unknown`)).status).toBe(404);
  });

  it("returns a bad-request (not a fabricated success id) for an empty/undeliverable send, and tolerates malformed nested payloads", async () => {
    const bus = new FakeInbox();
    await bus.provision("patient-10");
    server = await startEmailCatchServer(bus);

    // Empty body → nothing deliverable → 422, not { id: "...000000" }.
    const empty = await fetch(`${server.url}/emails`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(empty.status).toBe(422);

    // A null element inside SendGrid's arrays must not 500 the server (contained, clean response).
    const malformed = await fetch(`${server.url}/v3/mail/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { email: "a@example.test" }, subject: "x", personalizations: [null], content: [null] })
    });
    expect(malformed.status).toBe(422); // parsed to zero recipients → bad request, not a crash
    // The server is still healthy afterwards.
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });
});
