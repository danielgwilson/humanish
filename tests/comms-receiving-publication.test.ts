import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTOR_TRACE_SCHEMA, CODEX_APP_SERVER_CAPABILITIES, type ActorTrace } from "../src/actor-contract.js";
import type { CommsReceivingEvidence } from "../src/comms-receiving-types.js";
import { exportRun } from "../src/export.js";
import { draftFeedback } from "../src/feedback.js";
import { createShareSafetyAdmission } from "../src/observer-serve.js";
import { redactScreenshot } from "../src/redaction.js";
import { resolveRunPath, runDryRun, verifyRun, type RunBundle } from "../src/run.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";

const RUN = "synthetic-receiving-study";
const execFileAsync = promisify(execFile);
function evidence(): CommsReceivingEvidence {
  return { schema: "humanish.comms-receiving.v2", channel: "email", provider: "agentmail",
    publication: "restricted-real-communications", state: "finished", browserConfinement: "mail-surface-only",
    limitations: ["delivery_after_observation_end_unknown"],
    participants: [{ participantId: "lane-a", leaseId: "local-lease-canary", acquisition: "active", cleanup: "absent",
      observed: 1, published: 0, linkCount: 1, codeCount: 1, blockedAssetCount: 2, blockedLinkCount: 1,
      messages: [{ id: "message-000001", firstObservedAt: "2026-01-01T00:00:00.000Z" }], limitations: ["surface_publication_failed"] },
    { participantId: "lane-b", leaseId: "another-local-lease", acquisition: "active", cleanup: "absent",
      observed: 7, published: 7, linkCount: 0, codeCount: 0, blockedAssetCount: 0, blockedLinkCount: 0,
      messages: [], limitations: [] }] };
}

describe("receiving restrictions in retained evidence", () => {
  let cwd: string;
  let runDir: string;
  let bundle: RunBundle;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-receiving-publication-"));
    expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("share_ready");
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  async function save(): Promise<Buffer> {
    const bytes = Buffer.from(JSON.stringify(bundle));
    await writeFile(path.join(runDir, "run.json"), bytes);
    return bytes;
  }

  it.each(["publication marker", "receiving snapshot", "both"])("retains local-only status from %s across verify, feedback, public serving, HTML and blurred-bundle export", async marker => {
    if (marker !== "receiving snapshot") bundle.publication = { restrictions: ["real-communications"] };
    if (marker !== "publication marker") bundle.commsReceiving = evidence();
    await save();
    const verified = await verifyRun(cwd, RUN);
    expect(verified.ok).toBe(true);
    expect(verified.shareSafety).toEqual({ status: "local_only", reasons: [expect.objectContaining({ code: "REAL_COMMUNICATIONS" })] });
    expect(await createShareSafetyAdmission(cwd).admit(RUN)).toBe(false);
    expect((await draftFeedback(cwd, RUN)).error?.code).toBe("HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED");
    expect(await exportRun(cwd, RUN)).toMatchObject({ ok: false, error: { code: "HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED" } });
    const blurred = await exportRun(cwd, RUN, { format: "bundle", redactScreenshots: true, out: "public-copy" });
    expect(blurred.ok).toBe(false);
    await expect(stat(path.join(cwd, "public-copy"))).rejects.toMatchObject({ code: "ENOENT" });
    // No runtime registry or live coordinator exists in this fresh process.
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { verifyRun } from ${JSON.stringify(new URL("../src/run.ts", import.meta.url).href)}; const value = await verifyRun(process.argv[1], process.argv[2]); process.stdout.write(JSON.stringify({ ok: value.ok, shareSafety: value.shareSafety }));`, cwd, RUN],
    { cwd: path.resolve("."), env: { PATH: process.env.PATH ?? "" }, timeout: 20_000 });
    expect(JSON.parse(stdout)).toEqual({ ok: true, shareSafety: verified.shareSafety });
  });

  it("does not promote real email after actual screenshot blurring removes the raw-image reason", async () => {
    const image = new PNG({ width: 200, height: 120 });
    image.data.fill(255);
    const png = PNG.sync.write(image);
    const actor: ActorTrace = {
      schema: ACTOR_TRACE_SCHEMA, provider: "synthetic-fixture", protocol: "cua-loop", lane: "computer-use",
      persona: { id: "synthetic-reader", traitsApplied: [], promptDigest: "0123456789abcdef" },
      redaction: { status: "passed", screenshots: "raw", notes: "Synthetic screenshot." },
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000,
      status: "passed", completionReason: "goal_satisfied", reason: "Finished.", ids: {}, counts: { messages: 0, actions: 0 },
      items: [{ id: "frame", kind: "screenshot", lifecycle: "completed", title: "Inbox", screenshotRef: { path: "screenshots/frame.png", redaction: "none" } }],
      capabilities: { ...CODEX_APP_SERVER_CAPABILITIES, lanes: ["computer-use"], producesScreenshots: true }
    };
    bundle.streams[0]!.actor = actor;
    bundle.streams[0]!.artifacts.push({ kind: "screenshot", label: "Synthetic inbox frame", path: "screenshots/frame.png" });
    bundle.publication = { restrictions: ["real-communications"] };
    await mkdir(path.join(runDir, "screenshots"));
    await writeFile(path.join(runDir, "screenshots", "frame.png"), png);
    await save();
    expect((await verifyRun(cwd, RUN)).shareSafety.reasons.map(reason => reason.code)).toEqual(["REAL_COMMUNICATIONS", "RAW_SCREENSHOTS"]);
    const blurred = redactScreenshot(png);
    expect(blurred.mode).toBe("blurred");
    await writeFile(path.join(runDir, "screenshots", "frame.png"), blurred.buffer);
    actor.redaction.screenshots = "blurred";
    actor.items[0]!.screenshotRef!.redaction = "blurred";
    await save();
    expect((await verifyRun(cwd, RUN)).shareSafety).toEqual({ status: "local_only", reasons: [expect.objectContaining({ code: "REAL_COMMUNICATIONS" })] });
    expect((await exportRun(cwd, RUN, { format: "bundle", redactScreenshots: true, out: "blurred-copy" })).ok).toBe(false);
    // Counterfactual control: the screenshot now passes; the receiving marker independently blocks sharing.
    delete bundle.publication;
    await save();
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("share_ready");
  });

  it("supplies analysis only the matching participant's operational context and does not infer reading from receipt", async () => {
    bundle.commsReceiving = evidence();
    bundle.publication = { restrictions: ["real-communications"] };
    bundle.streams[0]!.laneId = "lane-a";
    const input = await captureStudyEvidence((await resolveRunPath(cwd, RUN))!, await save());
    const context = input.evidence.find(entry => entry.kind === "harness:email_receiving" && entry.streamId === bundle.streams[0]!.id);
    expect(context).toMatchObject({ eventId: `comms-receiving-${bundle.streams[0]!.id}`, quoteEligible: false, capture: null });
    expect(context!.text).toContain("observed=1; published=0");
    expect(context!.text).toContain("blocked assets=2; blocked links=1");
    expect(context!.text).toContain("surface_publication_failed");
    expect(context!.text).toContain("separate observations");
    expect(context!.text).toContain("does not establish that the target app failed to send");
    expect(context!.text).toContain("not confined");
    for (const absent of ["lane-b", "observed=7", "local-lease-canary", "message-000001", "2026-01-01T00:00:00.000Z"]) expect(context!.text).not.toContain(absent);
  });

  it.each(["providerMessageId", "address", "text", "apiKey"])("rejects unexpected %s in receiving evidence before making an analysis packet", async field => {
    bundle.commsReceiving = evidence();
    Object.assign(bundle.commsReceiving.participants[0]!, { [field]: "synthetic-private-field-canary" });
    await expect(captureStudyEvidence((await resolveRunPath(cwd, RUN))!, await save())).rejects.toThrow("ANALYSIS_SOURCE_INVALID");
  });
});
