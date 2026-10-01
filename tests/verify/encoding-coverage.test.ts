// Which encodings of a secret verify catches. Each case writes one file holding the synthetic key
// line in one encoding into a dry run that otherwise grades share_ready. `blocked` means the
// decoded text showed the key; `local_only` means verify could not read the bytes
// (UNSCANNED_ARTIFACT); `share_ready` is a known limit of the scan.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyRun } from "../../src/verify/verify.js";
import { shareSafetyDryRun, startSafeLibrary } from "../helpers/share-safety-run.js";

// Concatenated so this file never holds a secret-shaped literal.
const SECRET = "sk-" + "syntheticvalue1234567890abcdef";
const KEY_LINE = `OPENAI_API_KEY=${SECRET}`;

const base64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const percentEncoded = (text: string) =>
  [...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
const utf16be = (text: string) => Buffer.from(text, "utf16le").swap16();

/** Whether some standard-alphabet base64 run, decoded alone, shows the key. */
function standardRunShowsKey(text: string): boolean {
  return [...text.matchAll(/[A-Za-z0-9+/]{16,}/g)].some(([run]) =>
    Buffer.from(run, "base64").toString("latin1").includes(SECRET),
  );
}

/**
 * URL-safe base64 of the key line behind three 0x8f bytes. They encode to `j4-`, so the `-` sits
 * mid-quantum and any standard-alphabet run after it decodes misaligned.
 */
function base64urlWithDash(): string {
  const encoded = Buffer.concat([Buffer.alloc(3, 0x8f), Buffer.from(KEY_LINE)]).toString(
    "base64url",
  );
  if (!/[-_]/.test(encoded) || standardRunShowsKey(encoded))
    throw new Error("a standard-alphabet run shows the key");
  return encoded;
}

/** Quoted-printable: `=` as `=3D`, with a soft line break inside the key. */
function quotedPrintable(): string {
  const encoded = KEY_LINE.replace(/=/g, "=3D");
  const cut = encoded.indexOf("sk-") + 10;
  return `${encoded.slice(0, cut)}=\n${encoded.slice(cut)}\n`;
}

/** Base64 wrapped at 76 characters, with the key split by the first line break. */
function wrappedBase64(): string {
  // A 76-character line holds 57 bytes; this prefix puts the key's first 5 bytes on line one.
  const prefix = `${"x".repeat(57 - 5 - "OPENAI_API_KEY=".length - 1)} `;
  const wrapped = `${base64(prefix + KEY_LINE)
    .match(/.{1,76}/g)!
    .join("\n")}\n`;
  if (wrapped.split("\n").some((line) => standardRunShowsKey(line)))
    throw new Error("a single line shows the key");
  return wrapped;
}

const gzipShort = base64(gzipSync(SECRET));

type Grade = "blocked" | "local_only" | "share_ready";
interface Case {
  path: string;
  contents: string | Buffer;
  grade: Grade;
}

const CASES: Record<string, Case> = {
  "base64url (-_ alphabet)": {
    path: "adapter/a.txt",
    contents: base64urlWithDash(),
    grade: "blocked",
  },
  "base64 wrapped every 76 characters": {
    path: "adapter/a.txt",
    contents: wrappedBase64(),
    grade: "blocked",
  },
  "base64 split across two JSON string values": {
    path: "adapter/a.json",
    contents: JSON.stringify({ a: base64(KEY_LINE).slice(0, 32), b: base64(KEY_LINE).slice(32) }),
    grade: "share_ready",
  },
  "short base64 holding the key and binary bytes": {
    path: "adapter/a.txt",
    contents: base64(
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY_LINE), Buffer.from([255])]),
    ),
    grade: "blocked",
  },
  "base64 nested three deep": {
    path: "adapter/a.txt",
    contents: base64(base64(base64(KEY_LINE))),
    grade: "blocked",
  },
  "base64 nested four deep": {
    path: "adapter/a.txt",
    contents: base64(base64(base64(base64(KEY_LINE)))),
    grade: "share_ready",
  },
  "hex-encoded text": {
    path: "adapter/a.txt",
    contents: Buffer.from(KEY_LINE).toString("hex"),
    grade: "blocked",
  },
  "percent-encoding inside base64": {
    path: "adapter/a.txt",
    contents: base64(percentEncoded(KEY_LINE)),
    grade: "blocked",
  },
  "HTML entities inside \\u escapes": {
    path: "adapter/a.json",
    contents: `{"v":"${[...KEY_LINE].map((c) => `\\u0026#${c.charCodeAt(0)};`).join("")}"}`,
    grade: "blocked",
  },
  "UTF-16BE file": { path: "adapter/a.txt", contents: utf16be(KEY_LINE), grade: "local_only" },
  "base64 of UTF-16BE": {
    path: "adapter/a.txt",
    contents: base64(utf16be(KEY_LINE)),
    grade: "blocked",
  },
  "quoted-printable with a soft break in the key": {
    path: "adapter/a.eml",
    contents: quotedPrintable(),
    grade: "blocked",
  },
  "data: URI with base64 text in CSS": {
    path: "adapter/a.css",
    contents: `body{background:url(data:text/plain;base64,${base64(KEY_LINE)})}`,
    grade: "blocked",
  },
  "data: URI with base64 gzip in HTML": {
    path: "adapter/a.html",
    contents: `<a href="data:application/gzip;base64,${base64(gzipSync(KEY_LINE))}">x</a>`,
    grade: "local_only",
  },
  "gzip in base64 under 128 characters": {
    path: "adapter/a.txt",
    contents: gzipShort,
    grade: "local_only",
  },
};

describe("encoding coverage", () => {
  let cwd: string;
  const runs = new Map<string, string>();
  let observerRun: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-encoding-coverage-"));
    for (const [name, file] of Object.entries(CASES)) {
      const { runId, runDir } = await shareSafetyDryRun(cwd);
      await mkdir(path.join(runDir, "adapter"), { recursive: true });
      await writeFile(path.join(runDir, file.path), file.contents);
      runs.set(name, runId);
    }
    // observer/index.html is exempt from the opaque base64 rule; its text is still scanned.
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    await appendFile(path.join(runDir, "observer", "index.html"), `<!-- ${KEY_LINE} -->\n`);
    observerRun = runId;
  }, 120_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the short gzip case under the 128-character opaque length", () => {
    expect(gzipShort.length).toBeLessThan(128);
  });

  it.each(Object.entries(CASES))("%s", async (name, file) => {
    const verified = await verifyRun(cwd, runs.get(name)!);
    expect(verified.shareSafety.status).toBe(file.grade);
  });

  it("scans the text of observer/index.html", async () => {
    expect((await verifyRun(cwd, observerRun)).shareSafety.status).toBe("blocked");
  });

  it("serve --safe returns 404 for every caught case", async () => {
    const server = await startSafeLibrary(cwd);
    try {
      const caught = [
        observerRun,
        ...Object.entries(CASES)
          .filter(([, file]) => file.grade !== "share_ready")
          .map(([name]) => runs.get(name)!),
      ];
      for (const runId of caught) {
        const response = await fetch(new URL(`/_humanish/runs/${runId}/run.json`, server.url));
        expect(response.status, runId).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
});
