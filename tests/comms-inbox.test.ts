import { describe, expect, it } from "vitest";

import { FakeInbox } from "../src/comms-fake-inbox.js";
import {
  buildInboxSurface,
  inboxMessageJson,
  pickVerifyUrl,
  renderInboxList,
  renderInboxMessage,
  renderInboxMessageSynth,
  rewriteOrigin
} from "../src/comms-inbox.js";
import type { CommsMessage } from "../src/comms-types.js";

// A realistic captured verification email: an app-LOOPBACK verify link (must be origin-rewritten to be
// reachable), an OTP, HTML-unsafe header content is exercised separately, plus an active <script> to strip.
const VERIFICATION_HTML =
  '<p>Hi patient.</p><p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify your email</a></p><p>Or use code <b>481920</b>.</p><script>alert(1)</script>';

const MAP: Array<[string, string]> = [["http://127.0.0.1:3000", "https://3000-abc.e2b.app"]];

async function captured(subject = "Confirm your email"): Promise<CommsMessage[]> {
  const bus = new FakeInbox({ now: () => 1_700_000_000_000 });
  const patient = await bus.provisionAddress("patient", "patient-07@example.test");
  await bus.deliverRaw({ from: "Example Health <no-reply@example.test>", to: [patient.value], subject, body: VERIFICATION_HTML });
  return bus.poll(patient);
}

describe("comms-inbox: rewriteOrigin + pickVerifyUrl", () => {
  it("rewrites a link whose origin matches the map, leaves others untouched", () => {
    expect(rewriteOrigin("http://127.0.0.1:3000/verify?t=1", MAP)).toBe("https://3000-abc.e2b.app/verify?t=1");
    expect(rewriteOrigin("https://elsewhere.example.test/x", MAP)).toBe("https://elsewhere.example.test/x");
    expect(rewriteOrigin("http://127.0.0.1:3000", [])).toBe("http://127.0.0.1:3000"); // no map → unchanged
  });

  it("only rewrites on an ORIGIN BOUNDARY — a sibling origin sharing a prefix/suffix is never mangled", () => {
    expect(rewriteOrigin("http://127.0.0.1:30000/admin", MAP)).toBe("http://127.0.0.1:30000/admin"); // :30000 != :3000
    expect(rewriteOrigin("http://127.0.0.1:3000.evil.test/x", MAP)).toBe("http://127.0.0.1:3000.evil.test/x");
    expect(rewriteOrigin("http://127.0.0.1:3000", MAP)).toBe("https://3000-abc.e2b.app"); // exact origin
    expect(rewriteOrigin("http://127.0.0.1:3000/verify?t=1#frag", MAP)).toBe("https://3000-abc.e2b.app/verify?t=1#frag");
  });

  it("picks the verify-looking link, else the first, else undefined", () => {
    expect(pickVerifyUrl(["https://a.test/home", "https://a.test/confirm?t=1"])).toBe("https://a.test/confirm?t=1");
    expect(pickVerifyUrl(["https://a.test/x", "https://a.test/y"])).toBe("https://a.test/x");
    expect(pickVerifyUrl([])).toBeUndefined();
  });
});

describe("comms-inbox: real-email message view (the default)", () => {
  it("renders the app's real email in minimal chrome — origin-rewritten link, active content stripped", async () => {
    const [message] = await captured();
    const html = renderInboxMessage(message!, { originMap: MAP });
    expect(html).toContain("<!doctype html>");
    // header fields
    expect(html).toContain("Confirm your email");
    expect(html).toContain("patient-07@example.test");
    // the REAL email body is shown, with its verify link origin rewritten to the reachable host
    expect(html).toContain("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
    expect(html).not.toContain("http://127.0.0.1:3000/verify");
    // active content neutralized (no script execution in the surface page)
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
    // a link to the plain/synth fallback is present
    expect(html).toContain("/synth");
  });

  it("escapes HTML-unsafe header content (no header injection)", async () => {
    const [message] = await captured('Confirm <img src=x onerror="alert(1)">');
    const html = renderInboxMessage(message!, { originMap: MAP });
    expect(html).toContain("Confirm &lt;img"); // subject escaped in the header
    expect(html).not.toContain("<img src=x onerror"); // never a live tag from the header
  });

  it("defangs untrusted email HTML: script-blocking CSP + strips vectors the CSP alone would miss", async () => {
    const hostile =
      '<img/src=x/onerror="fetch(1)"> <iframe src=javascript:alert(1)></iframe> <a href=javascript:alert(2)>x</a>' +
      '<base href="http://evil/"> <meta http-equiv="refresh" content="0;url=http://evil/"> <script>alert(3)</script>' +
      '<p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify your account</a></p>';
    const bus = new FakeInbox();
    const patient = await bus.provisionAddress("patient", "patient-07@example.test");
    await bus.deliverRaw({ from: "no-reply@example.test", to: [patient.value], subject: "Confirm", body: hostile });
    const [message] = await bus.poll(patient);
    const html = renderInboxMessage(message!, { originMap: MAP });
    // The load-bearing, browser-enforced protection: a script-forbidding CSP is on the page.
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("script-src 'none'");
    // Defense-in-depth strip removed the active/redirect vectors (incl. the "/"-separated handler + the
    // unquoted javascript: URL that the original naive regex missed).
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<base");
    expect(html).not.toContain("refresh"); // the email's <meta http-equiv=refresh> redirect is stripped
    expect(html).not.toContain("http://evil"); // …so neither the base nor the refresh target survives
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
    // The legitimate verify link survives + is origin-rewritten to a reachable host.
    expect(html).toContain("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
  });
});

describe("comms-inbox: synthesized view (opt-in reliability fallback)", () => {
  it("renders a big verify button (rewritten) + the OTP, linking back to the real email", async () => {
    const [message] = await captured();
    const html = renderInboxMessageSynth(message!, { originMap: MAP });
    expect(html).toContain('class="verify"');
    expect(html).toContain("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
    expect(html).toContain("481920"); // OTP shown large
    expect(html).toContain("/inbox/" + message!.id); // back to the real email
  });
});

describe("comms-inbox: JSON twin (programmatic actors + reliability backstop)", () => {
  it("exposes id/from/to/subject/links/verifyUrl/otp, all origin-rewritten", async () => {
    const [message] = await captured();
    const json = inboxMessageJson(message!, { originMap: MAP });
    expect(json.to).toEqual(["patient-07@example.test"]);
    expect(json.subject).toBe("Confirm your email");
    expect(json.verifyUrl).toBe("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
    expect(json.otp).toBe("481920");
    expect((json.links as string[])[0]).toContain("3000-abc.e2b.app");
  });
});

describe("comms-inbox: buildInboxSurface (the served route→file set)", () => {
  it("emits list + per-message + latest + api routes, correct content types, list links to the message", async () => {
    const messages = await captured();
    const id = messages[0]!.id;
    const files = buildInboxSurface(messages, { originMap: MAP });
    const byPath = new Map(files.map((file) => [file.path, file]));
    // index semantics avoid a file-vs-dir collision (`/inbox` → inbox/index; `/inbox/{id}` stays a dir).
    for (const path of ["inbox/index", `inbox/${id}/index`, `inbox/${id}/synth`, "inbox/latest/index", "inbox/latest/synth", "api/inbox/index", `api/inbox/${id}`, "api/inbox/latest"]) {
      expect(byPath.has(path)).toBe(true);
    }
    expect(byPath.get("api/inbox/index")!.contentType).toContain("application/json");
    expect(byPath.get("inbox/index")!.contentType).toContain("text/html");
    expect(byPath.get("inbox/index")!.body).toContain(`/inbox/${id}`); // list links to the clean message URL
    expect(byPath.get("inbox/latest/index")!.body).toBe(byPath.get(`inbox/${id}/index`)!.body); // latest === the one message
    // no leading slash on any served path, and no path is both a leaf and a parent dir (no collision)
    const paths = files.map((file) => file.path);
    for (const p of paths) {
      expect(p.startsWith("/")).toBe(false);
      expect(paths.some((other) => other !== p && other.startsWith(p + "/"))).toBe(false);
    }
  });

  it("list JSON verifyUrl is origin-rewritten (consistent with the per-message endpoint)", async () => {
    const messages = await captured();
    const files = buildInboxSurface(messages, { originMap: MAP });
    const list = JSON.parse(files.find((file) => file.path === "api/inbox/index")!.body) as Array<{ verifyUrl?: string }>;
    expect(list[0]!.verifyUrl).toBe("https://3000-abc.e2b.app/verify?token=abc123XYZ-9");
  });

  it("an empty inbox renders an empty list + empty api and no message files", async () => {
    const files = buildInboxSurface([]);
    expect(files.map((file) => file.path).sort()).toEqual(["api/inbox/index", "inbox/index"]);
    expect(files.find((file) => file.path === "inbox/index")!.body).toContain("No messages yet");
    expect(files.find((file) => file.path === "api/inbox/index")!.body).toBe("[]");
  });
});

describe("comms-inbox: renderInboxList", () => {
  it("lists each message with an escaped subject linking to its id", async () => {
    const messages = await captured();
    const html = renderInboxList(messages);
    expect(html).toContain("<table>");
    expect(html).toContain("Confirm your email");
    expect(html).toContain(`/inbox/${messages[0]!.id}`);
  });
});
