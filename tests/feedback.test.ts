import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import {
  FEEDBACK_SCHEMA,
  draftFeedback,
  listFeedback,
  renderIssueMarkdown,
  renderIssueUrl,
  verifyFeedback
} from "../src/feedback.js";
import { createProgram } from "../src/program.js";
import { runDryRun } from "../src/run.js";

async function withFixtureCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-feedback-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  await program.parseAsync(["node", "humanish", ...args], { from: "node" });

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join("")
  };
}

describe("feedback issue drafts", () => {
  it("writes and verifies public-safe feedback draft artifacts", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "feedback-test"
      });

      const drafted = await draftFeedback(cwd, "latest");
      expect(drafted.ok).toBe(true);
      expect(drafted.draftPath).toBe(".humanish/runs/feedback-test/feedback/draft.json");
      expect(drafted.draft?.schema).toBe(FEEDBACK_SCHEMA);
      expect(drafted.draft?.redaction.status).toBe("passed");
      expect(drafted.draft?.idempotency_key).toBe("humanish:feedback-test:dry-run-contract-proof");

      await expect(stat(path.join(cwd, ".humanish/runs/feedback-test/feedback/draft.json"))).resolves.toBeTruthy();

      const listed = await listFeedback(cwd, "latest");
      expect(listed.ok).toBe(true);
      expect(listed.draft?.run_id).toBe("feedback-test");

      const verified = await verifyFeedback(cwd, "latest");
      expect(verified.ok).toBe(true);
    });
  });

  it("refuses a hardlinked feedback output without mutating its external inode", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({ cwd, dryRun: true, runId: "feedback-hardlink" });
      const feedbackDir = path.join(cwd, ".humanish", "runs", "feedback-hardlink", "feedback");
      const external = path.join(path.dirname(cwd), "feedback-external-sentinel.json");
      const original = "{\"external\":true}\n";
      await mkdir(feedbackDir);
      await writeFile(external, original, "utf8");
      await link(external, path.join(feedbackDir, "draft.json"));

      const drafted = await draftFeedback(cwd, "feedback-hardlink");
      expect(drafted.ok).toBe(false);
      expect(await readFile(external, "utf8")).toBe(original);
    });
  });

  it("keeps latest selection, verification, evidence reads, and writes on one physical run token", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-feedback-continuity-"));
    const physicalA = path.join(tempRoot, "physical-a");
    const physicalB = path.join(tempRoot, "physical-b");
    const cwdAlias = path.join(tempRoot, "cwd-alias");
    const originalJsonParse = JSON.parse;
    let retargeted = false;
    try {
      await cp(path.resolve("fixtures/minimal-app"), physicalA, { recursive: true });
      await cp(path.resolve("fixtures/minimal-app"), physicalB, { recursive: true });
      await runDryRun({ cwd: physicalA, dryRun: true, runId: "feedback-a" });
      await runDryRun({ cwd: physicalB, dryRun: true, runId: "feedback-b" });
      await symlink(physicalA, cwdAlias, "dir");
      JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        const value = originalJsonParse(text, reviver);
        if (
          !retargeted
          && typeof value === "object"
          && value !== null
          && (value as { runId?: unknown }).runId === "feedback-a"
          && (value as { path?: unknown }).path === ".humanish/runs/feedback-a"
        ) {
          unlinkSync(cwdAlias);
          symlinkSync(physicalB, cwdAlias, "dir");
          retargeted = true;
        }
        return value;
      }) as typeof JSON.parse;

      const drafted = await draftFeedback(cwdAlias, "latest");
      expect(retargeted).toBe(true);
      expect(drafted.ok).toBe(true);
      expect(drafted.draft?.run_id).toBe("feedback-a");
      expect(await stat(path.join(physicalA, ".humanish", "runs", "feedback-a", "feedback", "draft.json")))
        .toMatchObject({});
      await expect(stat(path.join(physicalB, ".humanish", "runs", "feedback-a", "feedback", "draft.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      JSON.parse = originalJsonParse;
      await unlink(cwdAlias).catch(() => undefined);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("refuses public feedback drafts for valid local-only evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "feedback-local-only"
      });

      const runPath = path.join(cwd, ".humanish/runs/feedback-local-only/run.json");
      const bundle = JSON.parse(await readFile(runPath, "utf8")) as {
        streams: Array<{ actor?: unknown }>;
      };
      bundle.streams[0]!.actor = {
        schema: ACTOR_TRACE_SCHEMA,
        redaction: {
          status: "passed",
          screenshots: "raw",
          notes: "Synthetic raw screenshot posture fixture."
        }
      };
      await writeFile(runPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const drafted = await draftFeedback(cwd, "latest");
      expect(drafted.ok).toBe(false);
      expect(drafted.error?.code).toBe("HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED");
      expect(drafted.error?.message).toContain("local_only");
      expect(drafted.error?.message).toContain("RAW_SCREENSHOTS");
      expect(drafted.shareSafety?.status).toBe("local_only");
      expect(drafted.shareSafety?.reasons.map((reason) => reason.code)).toContain("RAW_SCREENSHOTS");

      const issue = await runCli([
        "feedback",
        "issue",
        "--run",
        "latest",
        "--repo",
        "example/app",
        "--format",
        "markdown",
        "--cwd",
        cwd
      ]);
      expect(issue.exitCode).toBe(2);
      expect(issue.stdout).toBe("");
      expect(issue.stderr).toContain("HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED");
    });
  });

  it("renders Markdown and a URL without GitHub mutation", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "feedback-issue"
      });

      const rendered = await renderIssueMarkdown(cwd, "latest", "example/app");
      expect(rendered.ok).toBe(true);
      expect(rendered.issuePath).toBe(".humanish/runs/feedback-issue/feedback/issue.md");
      expect(rendered.issueMarkdown).toContain("humanish_feedback:");
      expect(rendered.issueMarkdown).toContain("GitHub mutation: not performed");
      expect(rendered.issueMarkdown).toContain("claim unobserved product behavior");
      expect(rendered.issueMarkdown).not.toMatch(/\bcloses?\b/i);

      const issueMarkdown = await readFile(
        path.join(cwd, ".humanish/runs/feedback-issue/feedback/issue.md"),
        "utf8"
      );
      expect(issueMarkdown).toBe(rendered.issueMarkdown);

      const issueUrl = await renderIssueUrl(cwd, "latest", "example/app");
      expect(issueUrl.ok).toBe(true);
      expect(issueUrl.issueUrl).toMatch(/^https:\/\/github\.com\/example\/app\/issues\/new\?/);
      expect(decodeURIComponent(issueUrl.issueUrl ?? "")).toContain("humanish_feedback:");
    });
  });

  it("drafts feedback from run feedback candidates before dry-run fallback", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "feedback-candidate"
      });

      const runPath = path.join(cwd, ".humanish/runs/feedback-candidate/run.json");
      const setupPath = path.join(cwd, ".humanish/runs/feedback-candidate/setup-quality/oss-01-setup-quality.json");
      await mkdir(path.dirname(setupPath), { recursive: true });
      await writeFile(setupPath, JSON.stringify({ schema: "humanish.setup-quality.v1", status: "needs_review" }, null, 2), "utf8");

      const bundle = JSON.parse(await readFile(runPath, "utf8")) as {
        feedbackCandidates: unknown[];
      };
      bundle.feedbackCandidates = [
        {
          schema: "humanish.feedback-candidate.v1",
          id: "setup-quality-oss-01",
          run_id: "feedback-candidate",
          stream_id: "oss-01",
          adapter_id: "oss-meta-lab",
          scenario_id: "oss-meta-lab",
          persona_id: "codex-oss-operator-01",
          actor: "codex-tui",
          substrate: "e2b-desktop",
          failure_owner: "actor",
          summary: "Fixture setup needs review",
          expected: "The actor should create a complete Humanish setup.",
          actual: "The package script was missing.",
          evidence: [
            {
              path: "setup-quality/oss-01-setup-quality.json",
              kind: "filesystem",
              note: "Setup-quality snapshot."
            }
          ],
          redaction: {
            status: "passed",
            notes: "Public-safe fixture candidate."
          },
          idempotency_key: "humanish:feedback-candidate:setup-quality",
          proposed_next_state: "setup-quality-review",
          acceptance_proof: [
            "pnpm humanish -- verify --run feedback-candidate --json"
          ]
        }
      ];
      await writeFile(runPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const drafted = await draftFeedback(cwd, "latest");
      expect(drafted.ok).toBe(true);
      expect(drafted.draft?.summary).toBe("Fixture setup needs review");
      expect(drafted.draft?.source_candidate_id).toBe("setup-quality-oss-01");
      expect(drafted.draft?.substrate).toBe("e2b-desktop");
      expect(drafted.draft?.evidence).toContainEqual({
        path: ".humanish/runs/feedback-candidate/setup-quality/oss-01-setup-quality.json",
        kind: "filesystem",
        note: "Setup-quality snapshot."
      });

      const rendered = await renderIssueMarkdown(cwd, "latest", "example/app");
      expect(rendered.ok).toBe(true);
      expect(rendered.issueMarkdown).toContain("source_candidate_id: setup-quality-oss-01");
      expect(rendered.issueMarkdown).toContain("Substrate: e2b-desktop");
    });
  });

  it("exposes issue Markdown and URL through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "feedback-cli"
      });

      const issue = await runCli([
        "feedback",
        "issue",
        "--run",
        "latest",
        "--repo",
        "example/app",
        "--format",
        "markdown",
        "--cwd",
        cwd
      ]);
      expect(issue.exitCode).toBe(0);
      expect(issue.stderr).toBe("");
      expect(issue.stdout).toContain("humanish_feedback:");
      expect(issue.stdout).toContain("GitHub mutation: not performed");

      const issueUrl = await runCli([
        "feedback",
        "issue-url",
        "--run",
        "latest",
        "--repo",
        "example/app",
        "--cwd",
        cwd,
        "--json"
      ]);
      expect(issueUrl.exitCode).toBe(0);
      const envelope = JSON.parse(issueUrl.stdout) as {
        ok: boolean;
        issueUrl: string;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.issueUrl).toMatch(/^https:\/\/github\.com\/example\/app\/issues\/new\?/);
    });
  });
});
