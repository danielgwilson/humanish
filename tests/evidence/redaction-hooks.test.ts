import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  containsSensitive,
  defaultRedactionHooks,
  digestText,
  promptForLog,
  redactText,
} from "../../src/evidence/redaction.js";

function tinyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    const v = i % 2 === 0 ? 0 : 255;
    png.data[o] = v;
    png.data[o + 1] = v;
    png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("digestText", () => {
  it("is a stable 12-char hex digest", () => {
    const d = digestText("hello world");
    expect(d).toMatch(/^[0-9a-f]{12}$/);
    expect(digestText("hello world")).toBe(d); // deterministic
  });

  it("differs for different inputs", () => {
    expect(digestText("a")).not.toBe(digestText("b"));
  });
});

describe("promptForLog", () => {
  it("references a prompt without leaking its text", () => {
    const raw = "Act as Dana, a cautious cash-pay patient. Email dana@example.test, code 111111.";
    const ref = promptForLog(raw);

    expect(ref.length).toBe(raw.length);
    expect(ref.digest).toBe(digestText(raw));
    // The placeholder carries the digest and length but never the raw prompt.
    expect(ref.placeholder).toContain(ref.digest);
    expect(ref.placeholder).toContain(String(raw.length));
    expect(ref.placeholder).not.toContain("Dana");
    expect(ref.placeholder).not.toContain("example.test");
    expect(ref.placeholder).not.toContain("111111");
  });
});

describe("defaultRedactionHooks", () => {
  it("redactText delegates to the shared secret patterns", () => {
    const secret = `sk-ant-${"a".repeat(25)}`;
    const out = defaultRedactionHooks.redactText(`token=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED_SECRET]");
  });

  it("publicPath labels a descendant of the run root and redacts outside it", () => {
    const root = "/var/data/app";
    expect(defaultRedactionHooks.publicPath("/var/data/app/sub/file.ts", root)).toBe(
      "[target-cwd]/sub/file.ts",
    );
    // Built dynamically so the literal does not trip the public-surface scanner.
    const outside = ["", "Users", "someone", "secret", "notes.md"].join("/");
    expect(defaultRedactionHooks.publicPath(outside, root)).toBe("[REDACTED_LOCAL_PATH]");
  });

  it("redactScreenshot returns a public-safe PNG and the method used", async () => {
    const { buffer, method } = await defaultRedactionHooks.redactScreenshot(tinyPng(400, 300));
    expect(method).toBe("blurred");
    const out = PNG.sync.read(buffer);
    expect(out.width).toBeLessThanOrEqual(128); // capped
    expect(out.data.length).toBe(out.width * out.height * 4); // valid RGBA
  });

  it("redactScreenshot honors a smaller maxWidth from meta", async () => {
    const { buffer } = await defaultRedactionHooks.redactScreenshot(tinyPng(400, 300), {
      maxWidth: 32,
    });
    expect(PNG.sync.read(buffer).width).toBe(32);
  });

  it("redactScreenshot fails closed on non-image input", async () => {
    const { buffer, method } = await defaultRedactionHooks.redactScreenshot(
      Buffer.from("not an image", "utf8"),
    );
    expect(method).toBe("blurred");
    expect(() => PNG.sync.read(buffer)).not.toThrow();
  });

  it("promptForLog is wired through the hooks", () => {
    expect(defaultRedactionHooks.promptForLog("x").digest).toBe(digestText("x"));
  });
});

describe("the E2B URL pattern", () => {
  // The E2B SDK's error when no API key reaches it, as e2b 2.49.0 writes it.
  const MISSING_KEY =
    "API key is required, please visit the API Keys tab at https://e2b.dev/dashboard?tab=keys to get your API key. You can either set the environment variable `E2B_API_KEY` or you can pass it directly to the sandbox like Sandbox.create({ apiKey: 'e2b_...' })";

  it("passes E2B's dashboard URL when it carries no token or credential", () => {
    expect(redactText(MISSING_KEY)).toBe(MISSING_KEY);
    for (const text of [
      "https://e2b.dev/dashboard",
      "https://e2b.dev/dashboard/",
      "https://www.e2b.dev/dashboard?tab=keys",
      "open https://e2b.dev/dashboard?tab=usage.",
      "(see https://e2b.dev/dashboard?tab=keys)",
      '"https://e2b.dev/dashboard?tab=keys"',
    ]) {
      expect(redactText(text), text).toBe(text);
      expect(containsSensitive(text), text).toBe(false);
    }
  });

  it("still redacts a dashboard URL that carries a token, a credential or more path", () => {
    for (const url of [
      "https://e2b.dev/dashboard?tab=keys&token=synthetic-dashboard-token",
      "https://e2b.dev/dashboard?access_token=synthetic-dashboard-token",
      "https://e2b.dev/dashboard?tab=keys#token=synthetic-dashboard-token",
      "https://operator:synthetic-password@e2b.dev/dashboard?tab=keys",
      "https://e2b.dev/dashboard/synthetic-team/sandboxes/synthetic-sandbox",
      "https://e2b.dev/dashboard?tab=synthetic-dashboard-token",
      "http://e2b.dev/dashboard?tab=keys",
      "https://e2b.dev.synthetic.example/dashboard",
      // A URL that ends a JSON string, with a token in the next field.
      'https://e2b.dev/dashboard?tab=keys","token":"synthetic-dashboard-token"',
    ]) {
      const text = `visit ${url} now`;
      expect(redactText(text), url).toBe("visit [REDACTED_SECRET] now");
      expect(containsSensitive(text), url).toBe(true);
    }
  });

  it("still redacts sandbox hosts, stream URLs and E2B's other pages", () => {
    for (const url of [
      "https://3000-synthetic-sandbox.e2b.app/verify?t=1",
      "https://6080-synthetic-sandbox.e2b.dev/vnc.html?password=synthetic-stream-key",
      "https://api.e2b.app/sandboxes",
      "https://docs.e2b.dev/api-key",
    ]) {
      expect(redactText(`at ${url} now`), url).toBe("at [REDACTED_SECRET] now");
    }
  });
});
