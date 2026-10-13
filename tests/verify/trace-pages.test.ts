// verify on the pages a computer-use trace records (`items[].page`, `finalPage`). A page keeps an
// origin and a path only, so a query string, a fragment or user info in one is a public-safety
// finding; the run writer's own output passes.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorTrace, TracePage } from "../../src/actors/contract.js";
import { sandboxIdDigest } from "../../src/evidence/redaction.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope } from "../../src/run/run.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import { verifyRun } from "../../src/verify/verify.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { syntheticActor, writeTwoParticipantRun } from "../helpers/run-traces.js";

const CLEAN: TracePage = { origin: "https://app.example.test", path: "/items/[REDACTED_URL_PART]" };

/** A trace whose one screenshot item is on `page`, ending on `finalPage`. */
function pagedActor(page: TracePage, finalPage: TracePage = page): ActorTrace {
  return {
    ...syntheticActor("Opened the item.", {
      kind: "screenshot",
      title: "turn-01",
      page,
    }),
    finalPage,
  };
}

describe("verify on recorded pages", () => {
  let cwd: string;
  let runs = 0;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-trace-pages-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** A fresh two-participant run whose first participant's trace is `first`, verified. */
  const grade = async (first: ActorTrace) => {
    const runId = `synthetic-trace-pages-${(runs += 1)}`;
    await runDryRun({ cwd, dryRun: true, runId });
    await writeTwoParticipantRun(path.join(cwd, ".humanish", "runs", runId), [
      first,
      syntheticActor("Opened the list."),
    ]);
    const verified = await verifyRun(cwd, runId);
    const scan = verified.checks.find((check) => check.name === "public-safety scan");
    return { status: verified.shareSafety.status, scan };
  };

  it("grades a run whose pages hold an origin and a redacted path share_ready", async () => {
    expect((await grade(pagedActor(CLEAN))).status).toBe("share_ready");
  });

  it("blocks a page whose path carries a query string or a fragment, naming where and not what", async () => {
    const query = await grade(pagedActor({ ...CLEAN, path: "/items/7?invite=a1b2" }));
    expect(query.status).toBe("blocked");
    expect(query.scan?.message).toContain("stream-one items[0].page");
    expect(query.scan?.message).not.toContain("invite");

    const fragment = await grade(pagedActor({ ...CLEAN, path: "/items/7#a1b2" }));
    expect(fragment.status).toBe("blocked");
  });

  it("blocks a final page whose origin carries user info or a path", async () => {
    const userInfo = await grade(
      pagedActor(CLEAN, { origin: "https://buyer:pass@app.example.test", path: "/" }),
    );
    expect(userInfo.status).toBe("blocked");
    expect(userInfo.scan?.message).toContain("stream-one finalPage");

    const withPath = await grade(
      pagedActor(CLEAN, { origin: "https://app.example.test/items", path: "/" }),
    );
    expect(withPath.status).toBe("blocked");

    // The URL parser reads a backslash after the host as a slash.
    const backslash = await grade(
      pagedActor(CLEAN, { origin: "https://[::1]\\items\\a1b2", path: "/" }),
    );
    expect(backslash.status).toBe("blocked");
  });

  it("reads only a redaction marker as a whole withheld origin, not any bracketed text", async () => {
    expect((await grade(pagedActor({ origin: "[REDACTED_SECRET]", path: "/" }))).status).toBe(
      "share_ready",
    );
    const bracketed = await grade(
      pagedActor({ origin: "[https://app.example.test?invite=a1b2]", path: "/" }),
    );
    expect(bracketed.status).toBe("blocked");
  });
});

describe("a finished run's pages", () => {
  let cwd: string;
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("are written with each journaled sandbox id as its digest, and verify reads the result as clean", async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-trace-pages-run-"));
    // Shaped like an E2B id and built at run time, so this file holds none.
    const raw = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
    await runDryRun({ cwd, dryRun: true, runId: "template" });
    const template = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "template", "run.json"), "utf8"),
    ) as RunBundle;
    const page = { origin: "https://app.example.test", path: `/sandboxes/${raw}` };
    const [stream] = template.streams;
    const runId = "paged";
    await runScope(async (scope) => {
      const started = await scope.startRun({
        cwd,
        runId,
        mintRunId: () => "minted",
        mode: "dry-run",
        renderReview: (bundle) => `# Review ${bundle.runId}\n`,
        observer: { open: false },
      });
      if (!started.ok) throw new Error(started.message);
      await appendSandboxReceipt(started.run.paths, { at: "t", laneId: "lane-01", sandboxId: raw });
      await started.run.finish(
        {
          ...template,
          runId,
          artifactRoot: path.join(".humanish", "runs", runId),
          streams: [{ ...stream!, actor: pagedActor(page) }],
        },
        PASSING_OUTCOME,
      );
    });
    const dir = path.join(cwd, ".humanish", "runs", runId);
    const stored = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")) as RunBundle;
    const written = `/sandboxes/[redacted-sandbox-id ${sandboxIdDigest(raw)}]`;
    expect(stored.streams[0]!.actor!.finalPage).toEqual({ ...page, path: written });
    const trace = JSON.parse(
      await readFile(path.join(dir, stored.streams[0]!.trace!.path), "utf8"),
    ) as ActorTrace;
    expect(trace.items[0]!.page).toEqual({ ...page, path: written });
    const scan = (await verifyRun(cwd, runId)).checks.find(
      (check) => check.name === "public-safety scan",
    );
    expect(scan?.ok).toBe(true);
  });
});
