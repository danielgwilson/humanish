import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { feedbackProofCommands, projectFeedbackAcceptanceProof } from "../src/feedback-proof.js";
import { draftFeedback, renderIssueMarkdown } from "../src/feedback.js";
import { runDryRun, type RunBundle, type RunFeedbackCandidate } from "../src/run.js";

const execFileAsync = promisify(execFile);
const RUN = "portable-proof";
const legacy = [`pnpm humanish -- verify --run ${RUN} --json`, `pnpm humanish -- watch --run ${RUN} --no-open`];
function fixture(kind = "participant-report"): { bundle: RunBundle; candidate: RunFeedbackCandidate } {
  const candidate = {
    schema: "humanish.feedback-candidate.v1", run_id: RUN, stream_id: "stream-001",
    id: `${kind}-stream-001`, actor: kind === "participant-report" ? "computer-use" : "codex-tui",
    adapter_id: kind === "participant-report" ? "synthetic-cua" : "oss-meta-lab", substrate: "e2b-desktop",
    failure_owner: kind === "participant-report" ? "target-app" : kind === "published-cli-app-url" ? "harness" : "actor",
    proposed_next_state: kind === "participant-report" || kind === "study-quality" ? "study-quality-review"
      : kind === "setup-quality" ? "setup-quality-review" : "adapter-hardening",
    idempotency_key: `humanish:${RUN}:stream-001:${kind}`, acceptance_proof: [...legacy],
    scenario_id: "synthetic-scenario", persona_id: "synthetic-persona", summary: "Synthetic finding",
    expected: "Review retained evidence.", actual: "Synthetic observation.", evidence: [],
    redaction: { status: "passed", notes: "Synthetic evidence." }
  } as RunFeedbackCandidate;
  return { candidate, bundle: { runId: RUN, streams: [{ id: "stream-001" }] } as RunBundle };
}

describe("portable feedback acceptance proof", () => {
  it.each(["participant-report", "setup-quality", "published-cli-app-url", "study-quality"])(
    "projects exact legacy commands for recognized %s without mutating source", (kind) => {
      const { bundle, candidate } = fixture(kind);
      const before = structuredClone(candidate);
      expect(projectFeedbackAcceptanceProof(bundle, candidate)).toEqual(Object.values(feedbackProofCommands(RUN)));
      expect(candidate).toEqual(before);
    });

  it.each(["run", "stream", "id", "key", "actor", "owner", "next", "adapter"])(
    "preserves custom candidates whose %s differs", (change) => {
      const { bundle, candidate } = fixture("setup-quality");
      if (change === "run") candidate.run_id = "another-run";
      if (change === "stream") candidate.stream_id = "missing-stream";
      if (change === "id") candidate.id = "custom-candidate";
      if (change === "key") candidate.idempotency_key = "custom-key";
      if (change === "actor") candidate.actor = "unknown";
      if (change === "owner") candidate.failure_owner = "target-app";
      if (change === "next") candidate.proposed_next_state = "watch";
      if (change === "adapter") candidate.adapter_id = "custom-adapter";
      expect(projectFeedbackAcceptanceProof(bundle, candidate)).toEqual(legacy);
    });

  it("preserves arbitrary prose, extra flags, other-run commands and near-matches", () => {
    const { bundle, candidate } = fixture();
    const custom = [
      "Run the application test suite.", `${legacy[0]} --custom`, ` ${legacy[0]}`,
      "pnpm humanish -- verify --run another-run --json", `echo '${legacy[0]}'`,
      "npm view humanish version", "pnpm test", "humanish verify --run portable-proof --json"
    ];
    candidate.acceptance_proof = [...custom, ...legacy];
    expect(projectFeedbackAcceptanceProof(bundle, candidate)).toEqual([...custom, ...Object.values(feedbackProofCommands(RUN))]);
  });

  it("passes an unusual run ID to the shell as one literal argument", async () => {
    const runId = "study ' $(printf INJECTED); `printf INJECTED` & example";
    const command = feedbackProofCommands(runId).verify;
    // Replace only the fixed executable with an argv-printing Node process; execute the
    // generated shell quoting itself. No candidate text is executed in integration proofs.
    const { stdout } = await execFileAsync("sh", ["-c",
      command.replace(/^humanish /, "node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- ")]);
    expect(JSON.parse(stdout)).toEqual(["verify", "--run", runId, "--json"]);
  });

  it("redrafts a retained first-party candidate without changing its bundle or receipt", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-portable-proof-"));
    try {
      await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
      await runDryRun({ cwd, dryRun: true, runId: RUN });
      const runDir = path.join(cwd, ".humanish", "runs", RUN);
      const bundlePath = path.join(runDir, "run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
      const candidate = fixture().candidate;
      candidate.stream_id = bundle.streams[0]!.id;
      bundle.feedbackCandidates = [candidate];
      await writeFile(bundlePath, JSON.stringify(bundle));
      const original = await readFile(bundlePath);
      const receipt = '{"schema":"synthetic.receipt.v1","digest":"synthetic"}\n';
      await writeFile(path.join(runDir, "receipt.json"), receipt);
      const drafted = await draftFeedback(cwd, RUN);
      expect(drafted.ok).toBe(true);
      expect(drafted.draft?.acceptance_proof).toEqual(Object.values(feedbackProofCommands(RUN)));
      const issue = await renderIssueMarkdown(cwd, RUN, "example/app");
      expect(issue.ok).toBe(true);
      expect(issue.issueMarkdown).toContain(feedbackProofCommands(RUN).verify);
      expect(issue.issueMarkdown).not.toContain("pnpm humanish");
      expect(await readFile(bundlePath)).toEqual(original);
      expect(await readFile(path.join(runDir, "receipt.json"), "utf8")).toBe(receipt);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.each(["dry-run", "live"] as const)("uses portable commands in a %s fallback draft", async (mode) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-proof-fallback-"));
    try {
      await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
      await runDryRun({ cwd, dryRun: true, runId: RUN });
      const bundlePath = path.join(cwd, ".humanish", "runs", RUN, "run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
      bundle.mode = mode;
      await writeFile(bundlePath, JSON.stringify(bundle));
      const result = await draftFeedback(cwd, RUN);
      expect(result.ok).toBe(true);
      expect(result.draft?.acceptance_proof).toEqual(Object.values(feedbackProofCommands(RUN)));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
