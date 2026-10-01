import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { runLab } from "../../src/lab/engine.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import type { BrowserLabScoringContext } from "../../src/lab/adapter-extension.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";
import type { RunAdapterArtifact } from "../../src/run/bundle.js";
import { verifyRun } from "../../src/verify/verify.js";

// Concatenated so this file never holds a secret-shaped literal; the text scan detects it.
const SYNTHETIC_SECRET = "sk-" + "syntheticvalue1234567890abcdef";
const PNG_4X4 = PNG.sync.write(new PNG({ width: 4, height: 4 }));
const STATE = Buffer.from(`${JSON.stringify({ env: `OPENAI_API_KEY=${SYNTHETIC_SECRET}` })}\n`);

interface AdapterFile {
  path: string;
  kind: RunAdapterArtifact["kind"];
  bytes: Buffer;
}

// verify reads extensions, not archive structure, so the zip case is the stored bytes behind a
// zip local-file signature.
const CASES: Record<string, AdapterFile> = {
  gzip: { path: "adapter/state.json.gz", kind: "state", bytes: gzipSync(STATE) },
  zip: {
    path: "adapter/state.zip",
    kind: "filesystem",
    bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), STATE]),
  },
  png: { path: "adapter/product-state.png", kind: "screenshot", bytes: PNG_4X4 },
};

function dryRunConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "unscanned-artifact",
    title: "Unscanned adapter artifact",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [
      { type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore and stop." },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "dry-run" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** A dry run whose adapter scorer writes one artifact into the run directory. */
async function runWithAdapterFile(cwd: string, file: AdapterFile): Promise<string> {
  const outcome = await runLab(dryRunConfig(), {
    cwd,
    scorer: {
      deriveArtifacts: async (ctx: BrowserLabScoringContext) => {
        await mkdir(path.join(ctx.runDir, path.dirname(file.path)), { recursive: true });
        await writeFile(path.join(ctx.runDir, file.path), file.bytes);
        return [
          {
            schema: "humanish.adapter-artifact.v1",
            namespace: "example",
            label: "Product state",
            path: file.path,
            kind: file.kind,
            note: "Synthetic adapter output.",
          },
        ];
      },
    },
  });
  if (outcome.backend !== "cua") throw new Error(`unexpected backend ${outcome.backend}`);
  return outcome.result.runId;
}

describe("verify does not grade an unreadable adapter artifact share_ready", () => {
  let cwd: string;
  const runIds = new Map<string, string>();

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-unscanned-"));
    for (const [name, file] of Object.entries(CASES)) {
      runIds.set(name, await runWithAdapterFile(cwd, file));
    }
    runIds.set(
      "text",
      await runWithAdapterFile(cwd, {
        path: "adapter/state.json",
        kind: "state",
        bytes: Buffer.from('{"status":"ok"}\n'),
      }),
    );
    runIds.set(
      "text-secret",
      await runWithAdapterFile(cwd, { path: "adapter/state.json", kind: "state", bytes: STATE }),
    );
  }, 60_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(Object.entries(CASES))(
    "grades a run with a %s adapter artifact local_only and names the file",
    async (name, file) => {
      const verified = await verifyRun(cwd, runIds.get(name)!);
      expect(verified.ok).toBe(true);
      expect(verified.shareSafety.status).toBe("local_only");
      const reason = verified.shareSafety.reasons.find(
        (candidate) => candidate.code === "UNSCANNED_ARTIFACT",
      );
      expect(reason?.message).toContain(file.path);
    },
  );

  it("keeps a text adapter artifact share_ready and blocks one that holds the secret", async () => {
    const clean = await verifyRun(cwd, runIds.get("text")!);
    expect(clean.shareSafety).toEqual({ status: "share_ready", reasons: [] });
    const leaked = await verifyRun(cwd, runIds.get("text-secret")!);
    expect(leaked.shareSafety.status).toBe("blocked");
  });

  describe("serve --safe", () => {
    let server: ServeLibraryServer;

    beforeAll(async () => {
      const started = await serveObserverLibrary(cwd, {
        port: 0,
        safe: true,
        expose: false,
        edgeAuthed: false,
      });
      if (!started.ok) throw new Error(started.error.message);
      server = started.server;
    });

    afterAll(async () => {
      await server.close();
    });

    it.each(Object.entries(CASES))("returns 404 for the %s artifact's run", async (name, file) => {
      const runId = runIds.get(name)!;
      for (const route of [file.path, "observer/index.html", "run.json"]) {
        const response = await fetch(new URL(`/_humanish/runs/${runId}/${route}`, server.url));
        expect(response.status).toBe(404);
      }
    });

    it("still serves a share_ready run's adapter artifact", async () => {
      const response = await fetch(
        new URL(`/_humanish/runs/${runIds.get("text")!}/adapter/state.json`, server.url),
      );
      expect(response.status).toBe(200);
    });
  });
});

/** A dry run with no scorer: share_ready until the test adds a file to its folder. */
async function dryRun(cwd: string): Promise<{ runId: string; runDir: string }> {
  const outcome = await runLab(dryRunConfig(), { cwd });
  if (outcome.backend !== "cua") throw new Error(`unexpected backend ${outcome.backend}`);
  const runId = outcome.result.runId;
  return { runId, runDir: path.join(cwd, ".humanish", "runs", runId) };
}

// Bytes the text scan cannot read, under names that do not say so. Each holds the synthetic secret.
const CONTENT_CASES: Record<string, { path: string; bytes: Buffer }> = {
  "gzip as .tar": { path: "adapter/state.tar", bytes: gzipSync(STATE) },
  "gzip as .bin": { path: "adapter/state.bin", bytes: gzipSync(STATE) },
  "gzip as .json": { path: "adapter/state.json", bytes: gzipSync(STATE) },
  "gzip as .txt": { path: "adapter/state.txt", bytes: gzipSync(STATE) },
  "gzip with no extension": { path: "adapter/state", bytes: gzipSync(STATE) },
  "UTF-16LE text": { path: "adapter/state.txt", bytes: Buffer.from(STATE.toString(), "utf16le") },
};

describe("verify reads a run file by its bytes, not its name", () => {
  let cwd: string;
  const unscanned = new Map<string, { runId: string; path: string }>();
  let backslash: { runId: string; path: string };
  let unreadable: { runId: string; path: string } | undefined;
  let oversized: { runId: string; path: string };

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-content-scan-"));
    for (const [name, file] of Object.entries(CONTENT_CASES)) {
      const { runId, runDir } = await dryRun(cwd);
      await mkdir(path.join(runDir, "adapter"), { recursive: true });
      await writeFile(path.join(runDir, file.path), file.bytes);
      unscanned.set(name, { runId, path: file.path });
    }
    {
      const { runId, runDir } = await dryRun(cwd);
      await writeFile(path.join(runDir, "adapter\\secret.txt"), STATE);
      backslash = { runId, path: "adapter\\secret.txt" };
    }
    // Root reads a mode-000 file, so the unreadable case only means something for other users.
    if (process.getuid?.() !== 0) {
      const { runId, runDir } = await dryRun(cwd);
      await writeFile(path.join(runDir, "locked.txt"), STATE);
      await chmod(path.join(runDir, "locked.txt"), 0o000);
      unreadable = { runId, path: "locked.txt" };
    }
    {
      // A sparse file past the 2 GiB a single read can return: the read fails without the bytes.
      const { runId, runDir } = await dryRun(cwd);
      const handle = await open(path.join(runDir, "large.txt"), "w");
      await handle.write(STATE, 0);
      await handle.truncate(2 ** 31 + 1);
      await handle.close();
      oversized = { runId, path: "large.txt" };
    }
  }, 60_000);

  afterAll(async () => {
    if (unreadable)
      await chmod(path.join(cwd, ".humanish", "runs", unreadable.runId, unreadable.path), 0o600);
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(Object.keys(CONTENT_CASES))("grades %s local_only and names the file", async (name) => {
    const { runId, path: file } = unscanned.get(name)!;
    const verified = await verifyRun(cwd, runId);
    expect(verified.ok).toBe(true);
    expect(verified.shareSafety.status).toBe("local_only");
    const reason = verified.shareSafety.reasons.find((r) => r.code === "UNSCANNED_ARTIFACT");
    expect(reason?.message).toContain(file);
  });

  it("grades a file it could not read local_only", async () => {
    for (const run of [unreadable, oversized]) {
      if (run === undefined) continue;
      const verified = await verifyRun(cwd, run.runId);
      expect(verified.shareSafety.status).toBe("local_only");
      const reason = verified.shareSafety.reasons.find((r) => r.code === "UNSCANNED_ARTIFACT");
      expect(reason?.message).toContain(run.path);
    }
  });

  it("blocks a file name with a backslash as an unsafe leaf", async () => {
    const verified = await verifyRun(cwd, backslash.runId);
    expect(verified.shareSafety.status).toBe("blocked");
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.message).toContain(
      "unsafe artifact leaf",
    );
  });

  it("serve --safe returns 404 for every one of these runs", async () => {
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: true,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    const server = started.server;
    try {
      const runs = [
        ...unscanned.values(),
        backslash,
        oversized,
        ...(unreadable ? [unreadable] : []),
      ];
      for (const { runId, path: file } of runs) {
        for (const route of [encodeURIComponent(file).replace(/%2F/g, "/"), "run.json"]) {
          const response = await fetch(new URL(`/_humanish/runs/${runId}/${route}`, server.url));
          expect(response.status).toBe(404);
        }
      }
    } finally {
      await server.close();
    }
  });
});

const SECRET_LINE = `OPENAI_API_KEY=${SYNTHETIC_SECRET}`;
const percentEncoded = (text: string) =>
  [...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");

// Each file holds the synthetic secret only in an encoded form. A secret the decoded text shows is
// blocked; an archive inside base64 is unscanned.
const ENCODED_CASES: Record<
  string,
  { path: string; text: string; grade: "blocked" | "local_only" }
> = {
  "base64 of gzip in a JSON value": {
    path: "adapter/state.json",
    text: JSON.stringify({ blob: gzipSync(SECRET_LINE).toString("base64") }),
    grade: "local_only",
  },
  "base64 of the key line": {
    path: "adapter/state.txt",
    text: Buffer.from(SECRET_LINE).toString("base64"),
    grade: "blocked",
  },
  "HTML entities": {
    path: "adapter/state.html",
    text: `<p>${[...SECRET_LINE].map((c) => `&#${c.charCodeAt(0)};`).join("")}</p>`,
    grade: "blocked",
  },
  "JSON \\u escapes": {
    path: "adapter/state.json",
    text: `{"env":"${[...SECRET_LINE].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`,
    grade: "blocked",
  },
  "percent-encoding": {
    path: "adapter/state.txt",
    text: percentEncoded(SECRET_LINE),
    grade: "blocked",
  },
  "base64 of UTF-16LE": {
    path: "adapter/state.txt",
    text: Buffer.from(SECRET_LINE, "utf16le").toString("base64"),
    grade: "blocked",
  },
  "base64 of base64": {
    path: "adapter/state.txt",
    text: Buffer.from(Buffer.from(SECRET_LINE).toString("base64")).toString("base64"),
    grade: "blocked",
  },
};

describe("verify decodes the encodings a reader undoes", () => {
  let cwd: string;
  const runs = new Map<string, { runId: string; path: string }>();

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-encoded-scan-"));
    for (const [name, file] of Object.entries(ENCODED_CASES)) {
      const { runId, runDir } = await dryRun(cwd);
      await mkdir(path.join(runDir, "adapter"), { recursive: true });
      await writeFile(path.join(runDir, file.path), file.text);
      runs.set(name, { runId, path: file.path });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(Object.entries(ENCODED_CASES))("grades %s", async (name, file) => {
    const verified = await verifyRun(cwd, runs.get(name)!.runId);
    expect(verified.shareSafety.status).toBe(file.grade);
    if (file.grade === "local_only") {
      const reason = verified.shareSafety.reasons.find((r) => r.code === "UNSCANNED_ARTIFACT");
      expect(reason?.message).toContain(file.path);
    }
  });

  it("serve --safe returns 404 for each of these runs", async () => {
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: true,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    try {
      for (const { runId, path: file } of runs.values()) {
        for (const route of [file, "run.json"]) {
          const response = await fetch(
            new URL(`/_humanish/runs/${runId}/${route}`, started.server.url),
          );
          expect(response.status).toBe(404);
        }
      }
    } finally {
      await started.server.close();
    }
  });
});
