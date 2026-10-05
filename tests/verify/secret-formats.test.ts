// verify's secret detection against common secret formats and against ordinary values that look a
// little like them. The scan runs on each value as written, percent-encoded and base64-encoded;
// verify grades a share-ready dry run blocked once a file holds any one format.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanEncodedText } from "../../src/evidence/encoded-text.js";
import { containsCredential, containsSensitive, redactText } from "../../src/evidence/redaction.js";
import { verifyRun } from "../../src/verify/verify.js";
import { ALNUM, ORDINARY_VALUES, SECRET_FORMATS, synthetic } from "../helpers/secret-formats.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";

// An E2B app host, `<port>-<sandbox id>.e2b.app`, with an id built at run time.
const E2B_APP_HOST = `3000-${synthetic("abcdefghijklmnopqrstuvwxyz0123456789", 20, 60)}.${"e2b"}.app`;

const ENCODINGS: Record<string, (text: string) => string> = {
  "as written": (text) => text,
  "percent-encoded": (text) => encodeURIComponent(text),
  base64: (text) => Buffer.from(text).toString("base64"),
  // A quoted-printable `=XX` reading of the first hex pair must not hide the rest.
  "hex-encoded in a parameter": (text) => `state=${Buffer.from(text).toString("hex")}`,
};

describe("secret formats", () => {
  it("covers at least fifteen formats", () => {
    expect(SECRET_FORMATS.length).toBeGreaterThanOrEqual(15);
  });

  for (const [encoding, encode] of Object.entries(ENCODINGS)) {
    it.each(SECRET_FORMATS.map((format) => [format.name, format.text] as const))(
      `finds %s ${encoding}`,
      (_name, text) => {
        expect(scanEncodedText(encode(text)).sensitive).toBe(true);
      },
    );
  }

  // The study URL check reads credentials only. It drops local paths and E2B app URLs, and nothing
  // else the share scan finds.
  for (const [encoding, encode] of Object.entries(ENCODINGS)) {
    it.each(
      SECRET_FORMATS.filter((format) => !format.name.endsWith(" path")).map(
        (format) => [format.name, format.text] as const,
      ),
    )(`finds %s ${encoding} as a credential`, (_name, text) => {
      expect(scanEncodedText(encode(text), { matches: containsCredential }).sensitive).toBe(true);
    });
  }

  it("finds an E2B app URL as sensitive and not as a credential", () => {
    const url = `https://${E2B_APP_HOST}/api/sign-in?origin=${encodeURIComponent(`https://${E2B_APP_HOST}`)}`;
    expect(scanEncodedText(url).sensitive).toBe(true);
    expect(scanEncodedText(url, { matches: containsCredential }).sensitive).toBe(false);
    expect(redactText(url)).not.toContain(E2B_APP_HOST);
  });

  it.each(ORDINARY_VALUES.map((value) => [value.name, value.text] as const))(
    "leaves %s alone",
    (_name, text) => {
      expect(scanEncodedText(text)).toEqual({ sensitive: false, opaque: false });
      expect(redactText(text)).toBe(text);
    },
  );

  it("redacts a URL credential and keeps the parameter name and the host", () => {
    const format = SECRET_FORMATS.find((entry) => entry.name === "Vercel share link")!;
    expect(redactText(format.text)).toBe(
      "https://preview-app-acme.vercel.app/dashboard?_vercel_share=[REDACTED_SECRET]",
    );
    const userinfo = SECRET_FORMATS.find((entry) => entry.name === "URL userinfo user:pass")!;
    expect(redactText(userinfo.text)).toBe(
      "opened https://user:[REDACTED_SECRET]@staging.example.com/",
    );
  });

  it("redacts a whole quoted value with punctuation, leaving no suffix", () => {
    const tail = synthetic(ALNUM, 12, 50);
    const text = `PASSWORD="CorrectHorse17Battery!${tail}"`;
    expect(redactText(text)).toBe('PASSWORD="[REDACTED_SECRET]"');
  });

  it.each([
    "eyJ-",
    "TOKEN=",
    "?token=",
    "https://:",
    "Authorization: Basic ",
    "aws_secret_access_key=",
    " ",
  ])("scans a megabyte of %j in linear time", (unit) => {
    const text = unit.repeat(Math.ceil((1 << 20) / unit.length));
    const started = performance.now();
    scanEncodedText(text);
    redactText(text);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it.each(["sk-", "eyJ", "Bearer ", "_authToken=", "?token=", "TOKEN=1", "", "0f"])(
    "redacts an 8 MB run after %j without overflowing the stack",
    (prefix) => {
      const text = `${prefix}${"a".repeat(8 << 20)}`;
      expect(() => containsSensitive(text)).not.toThrow();
      expect(() => redactText(text)).not.toThrow();
      expect(() => scanEncodedText(text)).not.toThrow();
    },
  );

  it.each([
    ["wrapped base64", `${"a".repeat(16)}\n${"aaaa\n".repeat(1 << 21)}`],
    ["a Windows path", `C:\\Users\\${"a\\".repeat(4 << 20)}`],
  ])("reads 8 MB of %s without overflowing the stack", (_name, text) => {
    expect(() => containsSensitive(text)).not.toThrow();
    expect(() => redactText(text)).not.toThrow();
    expect(() => scanEncodedText(text)).not.toThrow();
  });

  it("keeps JSON parseable when it redacts a value inside a JSON string", () => {
    for (const format of SECRET_FORMATS) {
      const redacted = redactText(JSON.stringify({ line: format.text }));
      expect(() => JSON.parse(redacted), format.name).not.toThrow();
    }
  });
});

describe("verify against secret formats", () => {
  let cwd: string;
  let runId: string;
  let runDir: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-secret-formats-"));
    ({ runId, runDir } = await shareSafetyDryRun(cwd));
  }, 60_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("grades the run share_ready with every ordinary value in a file", async () => {
    const file = path.join(runDir, "notes.txt");
    await writeFile(file, `${ORDINARY_VALUES.map((value) => value.text).join("\n")}\n`);
    try {
      expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");
    } finally {
      await rm(file);
    }
  });

  it("grades the run blocked for an E2B app URL that a study URL may carry", async () => {
    const file = path.join(runDir, "notes.txt");
    await writeFile(
      file,
      `opened https://${E2B_APP_HOST}/api/sign-in?origin=${encodeURIComponent(`https://${E2B_APP_HOST}`)}\n`,
    );
    try {
      const verified = await verifyRun(cwd, runId);
      expect(verified.shareSafety.status).toBe("blocked");
      expect(verified.shareSafety.reasons.map((reason) => reason.code)).toContain(
        "PUBLIC_SAFETY_FINDINGS",
      );
    } finally {
      await rm(file);
    }
  });

  it("grades the run blocked for each format", async () => {
    const file = path.join(runDir, "notes.txt");
    const missed: string[] = [];
    for (const format of SECRET_FORMATS) {
      await writeFile(file, `${format.text}\n`);
      const verified = await verifyRun(cwd, runId);
      const codes = verified.shareSafety.reasons.map((reason) => reason.code);
      if (verified.shareSafety.status !== "blocked" || !codes.includes("PUBLIC_SAFETY_FINDINGS"))
        missed.push(format.name);
    }
    await rm(file);
    expect(missed).toEqual([]);
  }, 60_000);
});
