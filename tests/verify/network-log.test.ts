// verify on a participant's browser network log (network/<participant id>.ndjson). The stream's
// `network` index binds the file by byte count, sha256 and record count, each record holds only the
// schema's keys and values, and every file under network/ is one a stream index names. A finding
// names the file and the line and never what the line says.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";

const ORIGIN = "https://app.example.test";

/** A clean log: a page load, a failed add to cart, a dropped connection and an open request. */
const CLEAN = [
  {
    at: "2026-10-16T10:00:07.812Z",
    turn: 0,
    method: "GET",
    origin: ORIGIN,
    path: "/",
    type: "document",
    status: 200,
    ms: 41,
  },
  {
    at: "2026-10-16T10:00:09.120Z",
    turn: 1,
    method: "POST",
    origin: ORIGIN,
    path: "/api/cart",
    type: "fetch",
    status: 500,
    ms: 88,
  },
  {
    at: "2026-10-16T10:00:09.300Z",
    turn: 1,
    method: "GET",
    origin: ORIGIN,
    path: "/api/drop",
    type: "fetch",
    failed: "ERR_EMPTY_RESPONSE",
    ms: 12,
  },
  {
    at: "2026-10-16T10:00:10.010Z",
    turn: 2,
    method: "GET",
    origin: ORIGIN,
    path: "/api/list",
    type: "xhr",
    pending: true,
  },
];

const ndjson = (records: object[]): string =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

describe("verify on a browser network log", () => {
  let cwd: string;
  let runs = 0;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-network-log-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /**
   * A dry run whose participant p1 carries a network log holding `text`, indexed by the bytes the
   * index records (`text`'s own unless `indexed` says otherwise) and the failed and pending counts
   * `counts` gives (the clean log's unless it says otherwise), then edited by `edit`. Returns the
   * grade, its reason codes and the public-safety scan's message.
   */
  const grade = async (
    text: string | undefined,
    edit: (runDir: string) => Promise<void> = async () => {},
    indexed: string | undefined = text,
    counts: { failed: number; pending: number } = { failed: 1, pending: 1 },
  ) => {
    const runId = `synthetic-network-log-${(runs += 1)}`;
    await runDryRun({ cwd, dryRun: true, runId });
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const file = path.join(runDir, "run.json");
    const bundle = JSON.parse(await readFile(file, "utf8")) as RunBundle;
    const [stream] = bundle.streams;
    if (stream === undefined) throw new Error("the dry run wrote no participant");
    stream.laneId = "p1";
    if (text !== undefined && indexed !== undefined) {
      const bytes = Buffer.from(indexed, "utf8");
      Object.assign(stream, {
        network: {
          schema: "humanish.browser-network.v1",
          path: "network/p1.ndjson",
          records: indexed.split("\n").length - 1,
          ...counts,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          startedAt: "2026-10-16T10:00:07.500Z",
          origins: [ORIGIN],
          complete: true,
          omitted: { otherOrigin: 2, overCap: 0, invalid: 0 },
        },
      });
      stream.artifacts.push({
        label: "participant p1 network log",
        path: "network/p1.ndjson",
        kind: "log",
      });
      await mkdir(path.join(runDir, "network"), { recursive: true });
      await writeFile(path.join(runDir, "network", "p1.ndjson"), text);
    }
    await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
    await edit(runDir);
    const verified = await verifyRun(cwd, runId);
    const scan = verified.checks.find((check) => check.name === "public-safety scan");
    return {
      status: verified.shareSafety.status,
      codes: verified.shareSafety.reasons.map((reason) => reason.code),
      message: scan?.message ?? "",
    };
  };

  /** The clean log with record `line` (from 1) changed by `change`, indexed as written. */
  const withRecord = (line: number, change: (record: Record<string, unknown>) => object) =>
    grade(
      ndjson(CLEAN.map((record, index) => (index === line - 1 ? change({ ...record }) : record))),
    );

  it("grades a run with a clean network log as it grades the run without one", async () => {
    const clean = await grade(ndjson(CLEAN));
    const without = await grade(undefined);
    expect({ status: clean.status, codes: clean.codes }).toEqual({
      status: without.status,
      codes: without.codes,
    });
  });

  it("blocks a record whose path holds a query string, naming the file and line and not the query", async () => {
    const result = await withRecord(2, (record) => ({ ...record, path: "/a?x=1" }));
    expect(result.status).toBe("blocked");
    expect(result.codes).toContain("PUBLIC_SAFETY_FINDINGS");
    expect(result.message).toContain("network/p1.ndjson line 2");
    expect(result.message).not.toContain("x=1");
  });

  it("blocks a record with a key outside the schema, such as headers", async () => {
    const result = await withRecord(1, (record) => ({ ...record, headers: { cookie: "s=1" } }));
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("network/p1.ndjson line 1");
    expect(result.message).not.toContain("cookie");
  });

  it("blocks a file that no longer matches its index after a one-byte edit", async () => {
    const text = ndjson(CLEAN);
    const result = await grade(text.replace("/api/cart", "/api/carT"), async () => {}, text);
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("network/p1.ndjson");
  });

  it("blocks a file under network/ that no stream index names, and an index path for another participant", async () => {
    const unindexed = await grade(ndjson(CLEAN), async (runDir) => {
      await writeFile(path.join(runDir, "network", "p2.ndjson"), ndjson(CLEAN));
    });
    expect(unindexed.status).toBe("blocked");
    expect(unindexed.message).toContain("network/p2.ndjson");

    const elsewhere = await grade(ndjson(CLEAN), async (runDir) => {
      const file = path.join(runDir, "run.json");
      const bundle = JSON.parse(await readFile(file, "utf8")) as RunBundle;
      bundle.streams[0]!.laneId = "p2";
      await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
    });
    expect(elsewhere.status).toBe("blocked");
  });

  it("blocks an index whose failed or pending count does not match its file", async () => {
    const text = ndjson(CLEAN);
    const failed = await grade(text, async () => {}, text, { failed: 0, pending: 1 });
    expect(failed.status).toBe("blocked");
    expect(failed.message).toContain("network/p1.ndjson");
    const pending = await grade(text, async () => {}, text, { failed: 1, pending: 2 });
    expect(pending.status).toBe("blocked");
  });

  it("blocks error text with its net:: prefix and a method in lowercase", async () => {
    const prefixed = await withRecord(3, (record) => ({ ...record, failed: "net::ERR_X" }));
    expect(prefixed.status).toBe("blocked");
    expect(prefixed.message).toContain("network/p1.ndjson line 3");

    const lowercase = await withRecord(1, (record) => ({ ...record, method: "get" }));
    expect(lowercase.status).toBe("blocked");
    expect(lowercase.message).toContain("network/p1.ndjson line 1");
  });

  it("blocks a record whose origin is not one its index lists, naming the line and not the origin", async () => {
    const result = await withRecord(2, (record) => ({
      ...record,
      origin: "https://accounts.google.com",
    }));
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("network/p1.ndjson line 2");
    expect(result.message).not.toContain("accounts.google.com");
  });

  // Regression guard: tracePage withholds a whole page whose address holds a study secret, so a
  // record's origin can be the marker its index never lists.
  it("grades a record whose origin and path are withheld whole as it grades the clean log", async () => {
    const clean = await grade(ndjson(CLEAN));
    const withheld = await withRecord(1, (record) => ({
      ...record,
      origin: "[REDACTED_URL_PART]",
      path: "[REDACTED_URL_PART]",
    }));
    expect({ status: withheld.status, codes: withheld.codes }).toEqual({
      status: clean.status,
      codes: clean.codes,
    });
  });
});
