import { createHash } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, CODEX_APP_SERVER_CAPABILITIES, type ActorTrace } from "../src/actor-contract.js";
import { exportRun, formatExportHuman } from "../src/export.js";
import { exportRedactedBundle } from "../src/export-bundle.js";
import { draftFeedback, renderIssueMarkdown, verifyFeedback } from "../src/feedback.js";
import { runDryRun, verifyRun, type RunBundle } from "../src/run.js";
import { computeStats } from "../src/stats.js";
import { createProgram } from "../src/program.js";

const RUN = "synthetic-export-study";
const OPTIONS = { format: "bundle" as const, redactScreenshots: true, out: "shared" };
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

async function treeHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const name of await readdir(path.join(root, relative))) {
      const rel = path.join(relative, name);
      if ((await stat(path.join(root, rel))).isDirectory()) await walk(rel);
      else result[rel] = sha(await readFile(path.join(root, rel)));
    }
  };
  await walk("");
  return result;
}

describe("redacted bundle export", () => {
  let cwd: string;
  let runDir: string;
  let png: Buffer;
  let original: RunBundle;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-bundle-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    const image = new PNG({ width: 640, height: 400 });
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = (i / 4) % 251; image.data[i + 1] = 110; image.data[i + 2] = 50; image.data[i + 3] = 255;
    }
    png = PNG.sync.write(image);
    await mkdir(path.join(runDir, "screenshots"));
    await writeFile(path.join(runDir, "screenshots", "frame.png"), png);
    const actor: ActorTrace = {
      schema: ACTOR_TRACE_SCHEMA, provider: "synthetic-fixture", protocol: "cua-loop", lane: "computer-use",
      persona: { id: "synthetic-new-user", traitsApplied: ["keyboard-first"], promptDigest: "0123456789abcdef" },
      redaction: { status: "passed", screenshots: "raw", notes: "Synthetic full-fidelity fixture." },
      startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:01.000Z", durationMs: 1000,
      status: "passed", completionReason: "goal_satisfied", reason: "Synthetic fixture completed.", ids: {},
      modelSettings: { reasoningEffort: "low", maxOutputTokens: 4096 }, counts: { messages: 1, actions: 1 },
      items: [{ id: "frame", kind: "screenshot", lifecycle: "completed", title: "Observed frame", screenshotRef: { path: "screenshots/frame.png", redaction: "none" } }],
      capabilities: { ...CODEX_APP_SERVER_CAPABILITIES, lanes: ["computer-use"], producesScreenshots: true }
    };
    original = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    original.streams[0]!.actor = actor;
    original.streams[0]!.artifacts.push({ kind: "screenshot", label: "frame (raw)", path: "screenshots/frame.png" });
    original.streams[0]!.artifacts.push({ kind: "trace", label: "actor", path: "actor.json" });
    original.feedbackCandidates = [{
      schema: "humanish.feedback-candidate.v1", id: "synthetic-finding", run_id: RUN,
      adapter_id: "synthetic-app", scenario_id: original.scenario.id, persona_id: original.persona.id,
      actor: "synthetic-dry-run", substrate: "local-filesystem", failure_owner: "harness",
      summary: "Synthetic evidence needs review", expected: "Inspect the synthetic fixture.", actual: "A synthetic frame was retained.",
      evidence: [{ path: "screenshots/frame.png", kind: "screenshot", note: "Synthetic frame." }],
      redaction: { status: "passed", notes: "Synthetic text." }, idempotency_key: "synthetic-finding",
      proposed_next_state: "watch", acceptance_proof: ["Inspect the synthetic frame."]
    }];
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    await writeFile(path.join(runDir, "actor.json"), JSON.stringify(actor));
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("local_only");
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("preserves the original and measured facts while standard commands use the independent derivative", async () => {
    const before = await treeHashes(path.join(cwd, ".humanish", "runs"));
    const statsBefore = await computeStats(cwd);
    const result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    expect(result).toMatchObject({ format: "bundle", path: "shared", embeddedImages: 1, shareSafety: { status: "share_ready" } });
    const shared = path.join(cwd, "shared");
    const derivativeDir = path.join(shared, ".humanish", "runs", RUN);
    const derivative = JSON.parse(await readFile(path.join(derivativeDir, "run.json"), "utf8")) as RunBundle;
    const observer = JSON.parse(await readFile(path.join(derivativeDir, "observer/observer-data.json"), "utf8"));
    expect(observer.publicSafety.share).toMatchObject({ status: "share_ready", reasons: [] });
    const observerHtml = await readFile(path.join(derivativeDir, "observer/index.html"), "utf8");
    expect(observerHtml).toContain('"status":"share_ready"');
    for (const key of ["runId", "mode", "createdAt", "source", "subject", "persona", "scenario", "review", "feedbackCandidates", "cost", "rerun"] as const) {
      expect(derivative[key]).toEqual(original[key]);
    }
    expect(derivative.streams[0]!.actor!.modelSettings).toEqual(original.streams[0]!.actor!.modelSettings);
    expect(derivative.streams[0]!.actor!.redaction.screenshots).toBe("blurred");
    expect(derivative.streams[0]!.actor!.redaction.notes).toContain(original.streams[0]!.actor!.redaction.notes);
    expect(derivative.redaction.notes).toContain(original.redaction.notes);
    expect(derivative.streams[0]!.actor!.items[0]!.screenshotRef!.redaction).toBe("blurred");
    const decoded = PNG.sync.read(await readFile(path.join(derivativeDir, "screenshots", "frame.png")));
    expect(decoded.width).toBe(96); expect(decoded.height).toBe(60);
    expect(await treeHashes(path.join(cwd, ".humanish", "runs"))).toEqual(before);
    expect(await computeStats(cwd)).toEqual(statsBefore);
    expect((await draftFeedback(cwd, RUN)).error?.code).toBe("HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED");
    expect((await exportRun(cwd, RUN)).ok).toBe(false);
    // Source is no longer available: downstream commands may only use the derivative.
    await rename(path.join(cwd, ".humanish", "runs"), path.join(cwd, "hidden-original"));
    expect((await verifyRun(shared, RUN)).shareSafety.status).toBe("share_ready");
    const feedback = await draftFeedback(shared, RUN);
    expect(feedback.ok).toBe(true); expect(feedback.draft?.source_candidate_id).toBe("synthetic-finding");
    expect((await verifyFeedback(shared, RUN)).ok).toBe(true);
    expect((await renderIssueMarkdown(shared, RUN, "example/app")).ok).toBe(true);
    const html = await exportRun(shared, RUN);
    expect(html.ok).toBe(true);
    if (!html.ok) return;
    const exported = await readFile(path.join(shared, html.path), "utf8");
    expect(exported).not.toContain(png.toString("base64"));
    expect(exported).toContain("data:image/png;base64,");
    const receipt = JSON.parse(await readFile(path.join(derivativeDir, "derivation.json"), "utf8"));
    expect(receipt.sourceRunId).toBe(RUN);
    expect(receipt.files.find((entry: { path: string }) => entry.path === "screenshots/frame.png")).toMatchObject({ action: "blurred", sourceSha256: sha(png) });
  });

  it("redacts unreferenced copies and rebuilds stale cached Observer content", async () => {
    await writeFile(path.join(runDir, "screenshots", "unused.PNG"), png);
    await writeFile(path.join(runDir, "observer", "index.html"), `<html>STALE<data value="data:image/png;base64,${png.toString("base64")}"></html>`);
    const result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.embeddedImages).toBe(2);
    const output = path.join(cwd, "shared", ".humanish", "runs", RUN);
    expect(PNG.sync.read(await readFile(path.join(output, "screenshots", "unused.PNG"))).width).toBe(96);
    expect(await readFile(path.join(output, "observer", "index.html"), "utf8")).not.toContain("STALE");
  });

  it.each([
    ["extra.zip", Buffer.from("synthetic archive")],
    ["extra.svg", Buffer.from("<svg></svg>")],
    ["extra.jpg", Buffer.from("synthetic unsupported image")],
    ["extra.txt", Buffer.from([0xff, 0xfe, 0])],
    ["extra.png", Buffer.from("not a PNG")],
    ["extra.json", Buffer.from('{"value":"data:image/png;base64,aaaa"}')],
    ["extra.json", Buffer.from('{"value":"\\u0064ata\\u003aimage/png;base64,aaaa"}')],
    ["extra.yml", Buffer.from('value: "\\x64ata:image/png;base64,aaaa"')]
  ])("refuses unsupported or concealed payload %s without completed output", async (name, bytes) => {
    await writeFile(path.join(runDir, name), bytes);
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(cwd)).filter((name) => name.startsWith(".humanish-export-"))).toEqual([]);
  });

  it("refuses a missing referenced frame and secret-shaped text", async () => {
    await rm(path.join(runDir, "screenshots", "frame.png"));
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
    await writeFile(path.join(runDir, "screenshots", "frame.png"), png);
    await writeFile(path.join(runDir, "extra.txt"), `sk-${"synthetic".repeat(8)}`);
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
  });

  it.each(["screenshots/missing.png", "https://example.test/untransformed.png", "../../outside.png"])("refuses unbacked actor frame reference %s even when ordinary verify passes", async (ref) => {
    original.streams[0]!.actor!.items[0]!.screenshotRef!.path = ref;
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    await writeFile(path.join(runDir, "actor.json"), JSON.stringify(original.streams[0]!.actor));
    expect((await verifyRun(cwd, RUN)).ok).toBe(true);
    const result = await exportRun(cwd, RUN, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("screenshot reference");
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing.txt", "sandbox-receipts.ndjson", "../../outside.txt"])("refuses candidate evidence that cannot survive the derivative: %s", async (ref) => {
    original.feedbackCandidates[0]!.evidence = [{ path: ref, kind: "log", note: "Synthetic reference." }];
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    await writeFile(path.join(runDir, "sandbox-receipts.ndjson"), "{}");
    const result = await exportRun(cwd, RUN, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Feedback evidence|Source evidence failed/);
  });

  it("refuses escaped sensitive YAML and preserves unusual JSON keys", async () => {
    await writeFile(path.join(runDir, "observation.json"), '{"__proto__":{"synthetic":true},"constructor":"synthetic"}');
    let result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.parse(await readFile(path.join(cwd, "shared", ".humanish", "runs", RUN, "observation.json"), "utf8")))
      .toEqual(JSON.parse('{"__proto__":{"synthetic":true},"constructor":"synthetic"}'));
    await writeFile(path.join(runDir, "encoded.yml"), `token: "\\x73k-${"x".repeat(32)}"`);
    expect((await verifyRun(cwd, RUN)).ok).toBe(true);
    result = await exportRun(cwd, RUN, { ...OPTIONS, out: "refused" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Decoded text");
  });

  it("keeps opaque JSON/NDJSON bytes and large identifiers exact", async () => {
    const json = '{ "id": 9223372036854775807, "fraction": 0.12345678901234567890123456789 }\n';
    await writeFile(path.join(runDir, "state.json"), json);
    await writeFile(path.join(runDir, "state.ndjson"), `${json}\n${json}`);
    const result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    const derived = path.join(cwd, "shared", ".humanish", "runs", RUN);
    expect(await readFile(path.join(derived, "state.json"), "utf8")).toBe(json);
    expect(await readFile(path.join(derived, "state.ndjson"), "utf8")).toBe(`${json}\n${json}`);
  });

  it("prints literal shell arguments in follow-up commands", async () => {
    const result = await exportRun(cwd, RUN, { ...OPTIONS, out: "literal $(touch sentinel) ' directory" });
    if (!result.ok) throw new Error(result.error.message);
    const formatted = formatExportHuman(result);
    expect(formatted).toContain("--cwd 'literal $(touch sentinel) '\"'\"' directory'");
  });

  it.each([
    { format: "bundle" as const },
    { ...OPTIONS, localOnly: true },
    { format: "html" as const, redactScreenshots: true }
  ])("rejects unsupported format/consent combinations", async (options) => {
    const result = await exportRun(cwd, RUN, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("HUMANISH_EXPORT_INVALID_OPTIONS");
  });

  it.each(["symlink", "hardlink"])("refuses a %s without modifying the target", async (kind) => {
    const target = path.join(cwd, "outside.txt"); await writeFile(target, "synthetic sentinel");
    if (kind === "symlink") await symlink(target, path.join(runDir, "unsafe.txt"));
    else await link(target, path.join(runDir, "unsafe.txt"));
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("synthetic sentinel");
  });

  it("refuses existing output, source overlap and output aliases into source before mutation", async () => {
    await mkdir(path.join(cwd, "shared"));
    const existing = await exportRun(cwd, RUN, OPTIONS);
    expect(existing.ok).toBe(false);
    if (!existing.ok) expect(existing.error.code).toBe("HUMANISH_EXPORT_OUTPUT_EXISTS");
    const before = await treeHashes(path.join(cwd, ".humanish", "runs"));
    await symlink(runDir, path.join(cwd, "source-alias"));
    for (const out of [`.humanish/runs/${RUN}/new/derivative`, ".humanish/runs/another", "source-alias/new/derivative"]) {
      expect((await exportRun(cwd, RUN, { ...OPTIONS, out })).ok).toBe(false);
    }
    expect(await treeHashes(path.join(cwd, ".humanish", "runs"))).toEqual(before);
    await expect(stat(path.join(runDir, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no output when source changes or publication is interrupted", async () => {
    let result = await exportRedactedBundle(cwd, RUN, OPTIONS, { beforePublish: async () => { throw new Error("synthetic interruption"); } });
    expect(result.ok).toBe(false);
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
    result = await exportRedactedBundle(cwd, RUN, OPTIONS, { beforePublish: async () => { await writeFile(path.join(runDir, "new.txt"), "concurrent mutation"); } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Source changed");
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(cwd)).filter((name) => name.startsWith(".humanish-export-"))).toEqual([]);
  });

  it("refuses canonical in-progress evidence even without process status", async () => {
    original.simulations[0]!.status = "preparing";
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    await rm(path.join(runDir, "status.json"), { force: true });
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
  });

  it.each(["0", "garbage", "12garbage", "1.5"])("rejects invalid CLI bundle byte cap %s", async (value) => {
    let stdout = ""; let exitCode = 0;
    const cli = createProgram({ writeOut: (s) => { stdout += s; }, writeErr: () => {}, setExitCode: (c) => { exitCode = c; } });
    await cli.parseAsync(["node", "humanish", "export", "--cwd", cwd, "--run", RUN, "--format", "bundle", "--redact-screenshots", "--max-bytes", value, "--json"]);
    expect(exitCode).toBe(2); expect(JSON.parse(stdout).error.code).toBe("HUMANISH_EXPORT_INVALID_OPTIONS");
  });
});
