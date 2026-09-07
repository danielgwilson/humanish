import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { draftFeedback, verifyFeedback } from "../src/feedback.js";
import { runDryRun, verifyRun, type RunBundle } from "../src/run.js";

const RUN = "declared-evidence";

describe("verify declared evidence references", () => {
  let cwd: string;
  let runDir: string;
  let bundle: RunBundle;
  let png: Buffer;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-evidence-refs-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    await mkdir(path.join(runDir, "screenshots"));
    await writeFile(path.join(runDir, "screenshots", "frame.PNG"), png);
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  const save = async () => { await writeFile(path.join(runDir, "run.json"), JSON.stringify(bundle)); };
  const setActor = (field: "actor" | "liveActor", items: unknown[]) => {
    // The canonical bundle permits partially shaped actor payloads. Verification must
    // inspect declared refs defensively, without requiring unrelated actor fields.
    Object.assign(bundle.streams[0]!, {
      [field]: { schema: field === "actor" ? ACTOR_TRACE_SCHEMA : "humanish.live-actor.v1", items,
        redaction: { status: "passed", screenshots: "raw", notes: "Synthetic raw frame." } }
    });
  };
  const candidateEvidence = (artifactPath: string, kind: "log" | "screenshot" = "log") => {
    bundle.feedbackCandidates = [{
      schema: "humanish.feedback-candidate.v1", id: "synthetic-finding", run_id: RUN,
      adapter_id: "synthetic-app", scenario_id: bundle.scenario.id, persona_id: bundle.persona.id,
      actor: "synthetic-dry-run", substrate: "local-filesystem", failure_owner: "harness",
      summary: "Synthetic finding", expected: "Retain supporting evidence.", actual: "An observation was recorded.",
      evidence: [{ path: artifactPath, kind, note: "Synthetic supporting evidence." }],
      redaction: { status: "passed", notes: "Synthetic text." }, idempotency_key: "synthetic-finding",
      proposed_next_state: "watch", acceptance_proof: ["Inspect the retained observation."]
    }];
  };
  const expectFailure = async (message: string) => {
    await save();
    const result = await verifyRun(cwd, RUN);
    expect(result.ok).toBe(false);
    expect(result.shareSafety.status).toBe("blocked");
    expect(result.checks.find((check) => check.name === "local evidence artifacts exist")?.message).toContain(message);
  };

  for (const field of ["actor", "liveActor"] as const) {
    it(`accepts a valid screenshot declared only in ${field}`, async () => {
      setActor(field, [{ screenshotRef: { path: "screenshots/frame.PNG", redaction: "none" } }]);
      await save();
      const result = await verifyRun(cwd, RUN);
      expect(result.ok).toBe(true);
      if (field === "actor") expect(result.shareSafety.status).toBe("local_only");
    });

    it.each([
      "screenshots/missing.png", "https://example.test/frame.png", "data:image/png;base64,synthetic",
      "../../outside.png", "../screenshots/frame.PNG", "/tmp/frame.png", "C:\\frames\\frame.png", "file:frame.png"
    ])(`rejects an unbacked or nonlocal ${field} screenshot: %s`, async (artifactPath) => {
      setActor(field, [{ screenshotRef: { path: artifactPath } }]);
      await expectFailure(artifactPath === "screenshots/missing.png" ? artifactPath : `${field}.items[0].screenshotRef`);
    });

    it.each([null, [], "frame.png", {}, { path: null }, { path: 3 }, { path: "" }])(
      `rejects a malformed present ${field} screenshot without throwing: %j`, async (screenshotRef) => {
        setActor(field, [{ screenshotRef }]);
        await expectFailure(`${field}.items[0].screenshotRef`);
      });

    it(`allows ${field} items without screenshot references`, async () => {
      setActor(field, [null, {}, { text: "No screenshot captured." }]);
      await save();
      expect((await verifyRun(cwd, RUN)).ok).toBe(true);
    });

    it(`rejects corrupt image evidence declared only in ${field}`, async () => {
      await writeFile(path.join(runDir, "screenshots", "frame.PNG"), "not a PNG");
      setActor(field, [{ screenshotRef: { path: "screenshots/frame.PNG" } }]);
      await expectFailure("expected PNG signature");
    });
  }

  it.each(["symlink", "hardlink"])("refuses a %s referenced only by an actor", async (kind) => {
    const external = path.join(cwd, "external.png");
    await writeFile(external, png);
    const target = path.join(runDir, "screenshots", "linked.png");
    if (kind === "symlink") await symlink(external, target);
    else await link(external, target);
    setActor("actor", [{ screenshotRef: { path: "screenshots/linked.png" } }]);
    await save();
    // The bound workspace inventory can reject links before individual reference checks.
    const result = await verifyRun(cwd, RUN);
    expect(result.ok).toBe(false);
    expect(result.shareSafety.status).toBe("blocked");
  });

  it("rejects a missing candidate-only log", async () => {
    candidateEvidence("missing.log");
    await expectFailure("missing.log");
  });

  it.each(["a retained observation\n", ""])("accepts a candidate-only regular log and its feedback draft: %j", async (text) => {
    await writeFile(path.join(runDir, "candidate.log"), text);
    candidateEvidence("candidate.log");
    await save();
    expect((await verifyRun(cwd, RUN)).ok).toBe(true);
    expect((await draftFeedback(cwd, RUN)).ok).toBe(true);
    expect((await verifyFeedback(cwd, RUN)).ok).toBe(true);
  });

  it("accepts a candidate-only PNG and rejects nonimage or empty screenshot evidence", async () => {
    candidateEvidence("screenshots/frame.PNG", "screenshot");
    await save();
    expect((await verifyRun(cwd, RUN)).ok).toBe(true);
    await writeFile(path.join(runDir, "screenshots", "frame.PNG"), "synthetic text");
    await expectFailure("expected PNG signature");
    await writeFile(path.join(runDir, "screenshots", "frame.PNG"), "");
    await expectFailure("screenshots/frame.PNG");
  });

  it("does not let an empty candidate log relax a strict adapter requirement", async () => {
    await writeFile(path.join(runDir, "candidate.log"), "");
    candidateEvidence("candidate.log");
    bundle.adapterArtifacts = [{ schema: "humanish.adapter-artifact.v1", namespace: "synthetic", label: "Strict consumer",
      path: "candidate.log", kind: "log", note: "Requires nonempty evidence." }];
    await expectFailure("candidate.log");
  });
});
