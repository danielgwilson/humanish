import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  type ActorTrace,
} from "../../src/actors/contract.js";
import { exportRun, formatExportHuman } from "../../src/feedback/export.js";
import { exportRedactedBundle } from "../../src/feedback/export-bundle.js";
import { draftFeedback, renderIssueMarkdown, verifyFeedback } from "../../src/feedback/feedback.js";
import { runSyntheticLive } from "../helpers/synthetic-live-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { type RunBundle } from "../../src/run/bundle.js";
import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { computeStats } from "../../src/run/stats.js";
import { storedCleanupSandbox, writeStoredCleanup } from "../helpers/stored-cleanup.js";
import { createProgram } from "../../src/cli/program.js";

const execFileAsync = promisify(execFile);

const RUN = "synthetic-export-study";
const OPTIONS = { format: "bundle" as const, redactScreenshots: true, out: "shared" };
function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
    await runSyntheticLive({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    const image = new PNG({ width: 640, height: 400 });
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = (i / 4) % 251;
      image.data[i + 1] = 110;
      image.data[i + 2] = 50;
      image.data[i + 3] = 255;
    }
    png = PNG.sync.write(image);
    await mkdir(path.join(runDir, "screenshots"));
    await writeFile(path.join(runDir, "screenshots", "frame.png"), png);
    const actor: ActorTrace = {
      schema: ACTOR_TRACE_SCHEMA,
      provider: "synthetic-fixture",
      protocol: "cua-loop",
      lane: "computer-use",
      persona: {
        id: "synthetic-new-user",
        traitsApplied: ["keyboard-first"],
        promptDigest: "0123456789abcdef",
      },
      redaction: {
        status: "passed",
        screenshots: "raw",
        notes: "Synthetic full-fidelity fixture.",
      },
      startedAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:01.000Z",
      durationMs: 1000,
      status: "passed",
      completionReason: "goal_satisfied",
      reason: "Synthetic fixture completed.",
      ids: {},
      modelSettings: { reasoningEffort: "low", maxOutputTokens: 4096 },
      counts: { messages: 1, actions: 1 },
      items: [
        {
          id: "frame",
          kind: "screenshot",
          lifecycle: "completed",
          title: "Observed frame",
          screenshotRef: { path: "screenshots/frame.png", redaction: "none" },
        },
      ],
      capabilities: {
        ...CODEX_APP_SERVER_CAPABILITIES,
        lanes: ["computer-use"],
        producesScreenshots: true,
      },
    };
    original = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    original.streams[0]!.actor = actor;
    original.streams[0]!.artifacts.push({
      kind: "screenshot",
      label: "frame (raw)",
      path: "screenshots/frame.png",
    });
    original.streams[0]!.artifacts.push({ kind: "trace", label: "actor", path: "actor.json" });
    original.feedbackCandidates = [
      {
        schema: "humanish.feedback-candidate.v1",
        id: "synthetic-finding",
        run_id: RUN,
        adapter_id: "synthetic-app",
        scenario_id: original.scenario.id,
        persona_id: original.persona.id,
        actor: "synthetic-dry-run",
        substrate: "local-filesystem",
        failure_owner: "harness",
        summary: "Synthetic evidence needs review",
        expected: "Inspect the synthetic fixture.",
        actual: "A synthetic frame was retained.",
        evidence: [{ path: "screenshots/frame.png", kind: "screenshot", note: "Synthetic frame." }],
        redaction: { status: "passed", notes: "Synthetic text." },
        idempotency_key: "synthetic-finding",
        proposed_next_state: "watch",
        acceptance_proof: ["Inspect the synthetic frame."],
      },
    ];
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    await writeFile(path.join(runDir, "actor.json"), JSON.stringify(actor));
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("local_only");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("preserves the original and measured facts while standard commands use the independent derivative", async () => {
    const before = await treeHashes(path.join(cwd, ".humanish", "runs"));
    const statsBefore = await computeStats(cwd);
    const result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    expect(result).toMatchObject({
      format: "bundle",
      path: "shared",
      embeddedImages: 1,
      shareSafety: { status: "share_ready" },
    });
    const shared = path.join(cwd, "shared");
    const derivativeDir = path.join(shared, ".humanish", "runs", RUN);
    const derivative = JSON.parse(
      await readFile(path.join(derivativeDir, "run.json"), "utf8"),
    ) as RunBundle;
    const observer = JSON.parse(
      await readFile(path.join(derivativeDir, "observer/observer-data.json"), "utf8"),
    );
    expect(observer.publicSafety.share).toMatchObject({ status: "share_ready", reasons: [] });
    const observerHtml = await readFile(path.join(derivativeDir, "observer/index.html"), "utf8");
    expect(observerHtml).toContain('"status":"share_ready"');
    for (const key of [
      "runId",
      "mode",
      "createdAt",
      "source",
      "subject",
      "persona",
      "scenario",
      "review",
      "feedbackCandidates",
      "cost",
      "rerun",
    ] as const) {
      expect(derivative[key]).toEqual(original[key]);
    }
    expect(derivative.streams[0]!.actor!.modelSettings).toEqual(
      original.streams[0]!.actor!.modelSettings,
    );
    expect(derivative.streams[0]!.actor!.redaction.screenshots).toBe("blurred");
    expect(derivative.streams[0]!.actor!.redaction.notes).toContain(
      original.streams[0]!.actor!.redaction.notes,
    );
    expect(derivative.redaction.notes).toContain(original.redaction.notes);
    expect(derivative.streams[0]!.actor!.items[0]!.screenshotRef!.redaction).toBe("blurred");
    const decoded = PNG.sync.read(
      await readFile(path.join(derivativeDir, "screenshots", "frame.png")),
    );
    expect(decoded.width).toBe(96);
    expect(decoded.height).toBe(60);
    expect(await treeHashes(path.join(cwd, ".humanish", "runs"))).toEqual(before);
    expect(await computeStats(cwd)).toEqual(statsBefore);
    expect((await draftFeedback(cwd, RUN)).error?.code).toBe(
      "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED",
    );
    expect((await exportRun(cwd, RUN)).ok).toBe(false);
    // Source is no longer available: downstream commands may only use the derivative.
    await rename(path.join(cwd, ".humanish", "runs"), path.join(cwd, "hidden-original"));
    expect((await verifyRun(shared, RUN)).shareSafety.status).toBe("share_ready");
    const feedback = await draftFeedback(shared, RUN);
    expect(feedback.ok).toBe(true);
    expect(feedback.draft?.source_candidate_id).toBe("synthetic-finding");
    expect((await verifyFeedback(shared, RUN)).ok).toBe(true);
    expect((await renderIssueMarkdown(shared, RUN, "example/app")).ok).toBe(true);
    const html = await exportRun(shared, RUN);
    expect(html.ok).toBe(true);
    if (!html.ok) return;
    const exported = await readFile(path.join(shared, html.path), "utf8");
    expect(exported).not.toContain(png.toString("base64"));
    expect(exported).toContain('type="application/octet-stream" data-mime="image/png"');
    const receipt = JSON.parse(await readFile(path.join(derivativeDir, "derivation.json"), "utf8"));
    expect(receipt.sourceRunId).toBe(RUN);
    expect(
      receipt.files.find((entry: { path: string }) => entry.path === "screenshots/frame.png"),
    ).toMatchObject({ action: "blurred", sourceSha256: sha(png) });
  });

  // verify cannot read an image that no stream trace registers, so the copy leaves it out.
  it("names no sandbox in the shared copy, and leaves the original's ids for cleanup", async () => {
    // Shaped like an E2B id and built at run time, so this file holds none for the scan to flag.
    const raw = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
    const withResource: RunBundle = {
      ...original,
      providerResources: [
        {
          schema: "humanish.provider-resource.v1",
          provider: "e2b-desktop",
          kind: "sandbox",
          id: raw,
          owner: "humanish",
          status: "killed",
        },
      ],
    };
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(withResource));
    await writeFile(
      path.join(runDir, "lease.json"),
      JSON.stringify({ sandbox: { sandboxId: raw }, subjectSandboxId: raw }),
    );
    await writeFile(path.join(runDir, "leases.ndjson"), `${JSON.stringify({ sandboxId: raw })}\n`);
    // Free text names the sandbox too: the receipts give export the exact id to replace there.
    await writeFile(
      path.join(runDir, "sandbox-receipts.ndjson"),
      `${JSON.stringify({ at: "t", laneId: "lane-01", provider: "e2b", sandboxId: raw })}\n`,
    );
    const review = path.join(runDir, "review.md");
    await writeFile(review, `${await readFile(review, "utf8")}\nSandbox ${raw} reclaimed.\n`);
    await writeFile(path.join(runDir, "teardown.log"), `kill(${raw}) returned true\n`);
    const result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    const copy = path.join(cwd, "shared", ".humanish", "runs", RUN);
    const shared = JSON.parse(await readFile(path.join(copy, "run.json"), "utf8")) as RunBundle;
    const digest = sandboxIdDigest(raw);
    expect(shared.providerResources?.map(({ id, idDigest }) => ({ id, idDigest }))).toEqual([
      { id: REDACTED_SANDBOX_ID, idDigest: digest },
    ]);
    expect(JSON.parse(await readFile(path.join(copy, "lease.json"), "utf8"))).toEqual({
      sandbox: { sandboxId: REDACTED_SANDBOX_ID, sandboxIdDigest: digest },
      subjectSandboxId: REDACTED_SANDBOX_ID,
      subjectSandboxIdDigest: digest,
    });
    expect(JSON.parse(await readFile(path.join(copy, "leases.ndjson"), "utf8"))).toEqual({
      sandboxId: REDACTED_SANDBOX_ID,
      sandboxIdDigest: digest,
    });
    expect(await readFile(path.join(copy, "review.md"), "utf8")).toContain(
      `Sandbox [redacted-sandbox-id ${digest}] reclaimed.`,
    );
    expect(await readFile(path.join(copy, "teardown.log"), "utf8")).toBe(
      `kill([redacted-sandbox-id ${digest}]) returned true\n`,
    );
    for (const file of ["run.json", "lease.json", "leases.ndjson", "review.md", "teardown.log"])
      expect(await readFile(path.join(copy, file), "utf8")).not.toContain(raw);
    await expect(readFile(path.join(copy, "sandbox-receipts.ndjson"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
    const source = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(source.providerResources?.[0]?.id).toBe(raw);
  });

  // Before 0.110, cleanup.json echoed run.json's raw id at resources[].id, with no digest beside it.
  it.each([
    ["with", true],
    ["without", false],
  ])(
    "names no sandbox from an older run's records and text, %s receipts",
    async (_label, receipts) => {
      const raw = ["i", "z5a8c3e1g7", "k2m4o6q9b"].join("");
      const resource = { kind: "sandbox" as const, owner: "humanish" as const, status: "killed" };
      await writeFile(
        path.join(runDir, "run.json"),
        JSON.stringify({
          ...original,
          providerResources: [
            {
              schema: "humanish.provider-resource.v1",
              provider: "e2b-desktop",
              ...resource,
              id: raw,
            },
          ],
        }),
      );
      await writeStoredCleanup(runDir, RUN, [storedCleanupSandbox(raw)]);
      // Free text and YAML name it too; without receipts, run.json's keyed id is how export knows it.
      const review = path.join(runDir, "review.md");
      await writeFile(review, `${await readFile(review, "utf8")}\nSandbox ${raw} reclaimed.\n`);
      await writeFile(path.join(runDir, "lease.yaml"), `sandboxId: ${raw}\n`);
      if (receipts)
        await writeFile(
          path.join(runDir, "sandbox-receipts.ndjson"),
          `${JSON.stringify({ at: "t", laneId: "lane-01", provider: "e2b", sandboxId: raw })}\n`,
        );

      const result = await exportRun(cwd, RUN, OPTIONS);
      if (!result.ok) throw new Error(result.error.message);
      const copy = path.join(cwd, "shared", ".humanish", "runs", RUN);
      const shared = JSON.parse(await readFile(path.join(copy, "cleanup.json"), "utf8")) as {
        resources: unknown[];
      };
      expect(shared.resources).toMatchObject([
        { id: REDACTED_SANDBOX_ID, idDigest: sandboxIdDigest(raw) },
      ]);
      // YAML drops the brackets, which would turn the value into a list.
      const label = `redacted-sandbox-id-${sandboxIdDigest(raw)}`;
      expect(parseYaml(await readFile(path.join(copy, "lease.yaml"), "utf8"))).toEqual({
        sandboxId: label,
      });
      for (const file of Object.keys(await treeHashes(copy)))
        expect((await readFile(path.join(copy, file))).includes(raw), file).toBe(false);
    },
  );

  it("drops unreferenced copies, keeps referenced frames and rebuilds stale cached Observer content", async () => {
    await writeFile(path.join(runDir, "screenshots", "unused.PNG"), png);
    await writeFile(
      path.join(runDir, "observer", "index.html"),
      `<html>STALE<data value="data:image/png;base64,${png.toString("base64")}"></html>`,
    );
    const result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.embeddedImages).toBe(1);
    const output = path.join(cwd, "shared", ".humanish", "runs", RUN);
    await expect(stat(path.join(output, "screenshots", "unused.PNG"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const derivation = JSON.parse(await readFile(path.join(output, "derivation.json"), "utf8"));
    expect(
      derivation.files.find((entry: { path: string }) => entry.path === "screenshots/unused.PNG"),
    ).toMatchObject({ action: "omitted" });
    // The referenced frame stays at its path, blurred, and the copy holds no unregistered image.
    const exported = JSON.parse(await readFile(path.join(output, "run.json"), "utf8")) as RunBundle;
    expect(exported.streams[0]!.actor!.items[0]!.screenshotRef).toEqual({
      path: "screenshots/frame.png",
      redaction: "blurred",
    });
    expect(PNG.sync.read(await readFile(path.join(output, "screenshots", "frame.png"))).width).toBe(
      96,
    );
    expect(await readdir(path.join(output, "screenshots"))).toEqual(["frame.png"]);
    const verified = await verifyRun(path.join(cwd, "shared"), RUN);
    expect(verified.shareSafety).toEqual({ status: "share_ready", reasons: [] });
    expect(await readFile(path.join(output, "observer", "index.html"), "utf8")).not.toContain(
      "STALE",
    );
  });

  it("refuses to draft or export a run whose evidence cites an image that is not a stream screenshot", async () => {
    await writeFile(path.join(runDir, "screenshots", "extra.png"), png);
    original.feedbackCandidates[0]!.evidence.push({
      path: "screenshots/extra.png",
      kind: "screenshot",
      note: "An image no stream trace registers.",
    });
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    const source = await verifyRun(cwd, RUN);
    expect(source.shareSafety.reasons.map((reason) => reason.code)).toContain("UNSCANNED_ARTIFACT");
    const draft = await draftFeedback(cwd, RUN);
    expect(draft.ok).toBe(false);
    expect(draft.error?.code).toBe("HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED");
    const result = await exportRun(cwd, RUN, OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_EXPORT_BUNDLE_REFUSED");
    expect(result.error.message).toContain("not a stream screenshot");
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["extra.zip", Buffer.from("synthetic archive")],
    ["extra.svg", Buffer.from("<svg></svg>")],
    ["extra.jpg", Buffer.from("synthetic unsupported image")],
    ["extra.txt", Buffer.from([0xff, 0xfe, 0])],
    ["extra.png", Buffer.from("not a PNG")],
    ["extra.json", Buffer.from('{"value":"data:image/png;base64,aaaa"}')],
    ["extra.json", Buffer.from('{"value":"\\u0064ata\\u003aimage/png;base64,aaaa"}')],
    ["extra.yml", Buffer.from('value: "\\x64ata:image/png;base64,aaaa"')],
  ])(
    "refuses unsupported or concealed payload %s without completed output",
    async (name, bytes) => {
      await writeFile(path.join(runDir, name), bytes);
      expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
      await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(cwd)).filter((name) => name.startsWith(".humanish-export-"))).toEqual(
        [],
      );
    },
  );

  it("refuses a missing referenced frame and secret-shaped text", async () => {
    await rm(path.join(runDir, "screenshots", "frame.png"));
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
    await writeFile(path.join(runDir, "screenshots", "frame.png"), png);
    await writeFile(path.join(runDir, "extra.txt"), `sk-${"synthetic".repeat(8)}`);
    expect((await exportRun(cwd, RUN, OPTIONS)).ok).toBe(false);
  });

  it.each([
    "screenshots/missing.png",
    "https://example.test/untransformed.png",
    "../../outside.png",
  ])("refuses unbacked actor frame reference %s in ordinary verify and export", async (ref) => {
    original.streams[0]!.actor!.items[0]!.screenshotRef!.path = ref;
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
    await writeFile(path.join(runDir, "actor.json"), JSON.stringify(original.streams[0]!.actor));
    expect((await verifyRun(cwd, RUN)).ok).toBe(false);
    const result = await exportRun(cwd, RUN, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Source evidence failed");
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing.txt", "sandbox-receipts.ndjson", "../../outside.txt"])(
    "refuses candidate evidence that cannot survive the derivative: %s",
    async (ref) => {
      original.feedbackCandidates[0]!.evidence = [
        { path: ref, kind: "log", note: "Synthetic reference." },
      ];
      await writeFile(path.join(runDir, "run.json"), JSON.stringify(original));
      await writeFile(path.join(runDir, "sandbox-receipts.ndjson"), "{}");
      expect((await verifyRun(cwd, RUN)).ok).toBe(ref === "sandbox-receipts.ndjson");
      const result = await exportRun(cwd, RUN, OPTIONS);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toMatch(/Feedback evidence|Source evidence failed/);
    },
  );

  it("blocks escaped sensitive YAML in verify and export, and preserves unusual JSON keys", async () => {
    await writeFile(
      path.join(runDir, "observation.json"),
      '{"__proto__":{"synthetic":true},"constructor":"synthetic"}',
    );
    let result = await exportRun(cwd, RUN, OPTIONS);
    if (!result.ok) throw new Error(result.error.message);
    expect(
      JSON.parse(
        await readFile(
          path.join(cwd, "shared", ".humanish", "runs", RUN, "observation.json"),
          "utf8",
        ),
      ),
    ).toEqual(JSON.parse('{"__proto__":{"synthetic":true},"constructor":"synthetic"}'));
    await writeFile(path.join(runDir, "encoded.yml"), `token: "\\x73k-${"x".repeat(32)}"`);
    // verify decodes the escape as export does, so the source is blocked before export reads it.
    const verified = await verifyRun(cwd, RUN);
    expect(verified.ok).toBe(false);
    expect(verified.shareSafety.status).toBe("blocked");
    result = await exportRun(cwd, RUN, { ...OPTIONS, out: "refused" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("HUMANISH_EXPORT_VERIFY_FAILED");
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
    const out = "literal $(touch sentinel) ' directory";
    const result = await exportRun(cwd, RUN, { ...OPTIONS, out });
    if (!result.ok) throw new Error(result.error.message);
    const verify = formatExportHuman(result)
      .split("\n")
      .find((line) => line.trim().startsWith("verify: "));
    if (verify === undefined) throw new Error("no verify line");
    // The shell reads the printed --cwd back as the literal path, and runs nothing inside it.
    const command = verify.trim().slice("verify: ".length);
    const { stdout } = await execFileAsync("sh", ["-c", `set -- ${command}; printf '%s' "$4"`], {
      cwd,
    });
    expect(stdout).toBe(result.path);
    expect(stdout).toContain(out);
    await expect(stat(path.join(cwd, "sentinel"))).rejects.toThrow("ENOENT");
  });

  it.each([
    { format: "bundle" as const },
    { ...OPTIONS, localOnly: true },
    { format: "html" as const, redactScreenshots: true },
  ])("rejects unsupported format/consent combinations", async (options) => {
    const result = await exportRun(cwd, RUN, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("HUMANISH_EXPORT_INVALID_OPTIONS");
  });

  it.each(["symlink", "hardlink"])("refuses a %s without modifying the target", async (kind) => {
    const target = path.join(cwd, "outside.txt");
    await writeFile(target, "synthetic sentinel");
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
    for (const out of [
      `.humanish/runs/${RUN}/new/derivative`,
      ".humanish/runs/another",
      "source-alias/new/derivative",
    ]) {
      expect((await exportRun(cwd, RUN, { ...OPTIONS, out })).ok).toBe(false);
    }
    expect(await treeHashes(path.join(cwd, ".humanish", "runs"))).toEqual(before);
    await expect(stat(path.join(runDir, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no output when source changes or publication is interrupted", async () => {
    let result = await exportRedactedBundle(cwd, RUN, OPTIONS, {
      beforePublish: async () => {
        throw new Error("synthetic interruption");
      },
    });
    expect(result.ok).toBe(false);
    await expect(stat(path.join(cwd, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
    result = await exportRedactedBundle(cwd, RUN, OPTIONS, {
      beforePublish: async () => {
        await writeFile(path.join(runDir, "new.txt"), "concurrent mutation");
      },
    });
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

  it.each(["0", "garbage", "12garbage", "1.5"])(
    "rejects invalid CLI bundle byte cap %s",
    async (value) => {
      let stdout = "";
      let exitCode = 0;
      const cli = createProgram({
        writeOut: (s) => {
          stdout += s;
        },
        writeErr: () => {},
        setExitCode: (c) => {
          exitCode = c;
        },
      });
      await cli.parseAsync([
        "node",
        "humanish",
        "export",
        "--cwd",
        cwd,
        "--run",
        RUN,
        "--format",
        "bundle",
        "--redact-screenshots",
        "--max-bytes",
        value,
        "--json",
      ]);
      expect(exitCode).toBe(2);
      expect(JSON.parse(stdout).error.code).toBe("HUMANISH_EXPORT_INVALID_OPTIONS");
    },
  );
});
