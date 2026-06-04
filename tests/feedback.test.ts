import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-feedback-fixture-"));
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

  await program.parseAsync(["node", "mimetic", ...args], { from: "node" });

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
      expect(drafted.draftPath).toBe(".mimetic/runs/feedback-test/feedback/draft.json");
      expect(drafted.draft?.schema).toBe(FEEDBACK_SCHEMA);
      expect(drafted.draft?.redaction.status).toBe("passed");
      expect(drafted.draft?.idempotency_key).toBe("mimetic:feedback-test:dry-run-contract-proof");

      await expect(stat(path.join(cwd, ".mimetic/runs/feedback-test/feedback/draft.json"))).resolves.toBeTruthy();

      const listed = await listFeedback(cwd, "latest");
      expect(listed.ok).toBe(true);
      expect(listed.draft?.run_id).toBe("feedback-test");

      const verified = await verifyFeedback(cwd, "latest");
      expect(verified.ok).toBe(true);
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
      expect(rendered.issuePath).toBe(".mimetic/runs/feedback-issue/feedback/issue.md");
      expect(rendered.issueMarkdown).toContain("mimetic_feedback:");
      expect(rendered.issueMarkdown).toContain("GitHub mutation: not performed");
      expect(rendered.issueMarkdown).toContain("claim unobserved product behavior");
      expect(rendered.issueMarkdown).not.toMatch(/\bcloses?\b/i);

      const issueMarkdown = await readFile(
        path.join(cwd, ".mimetic/runs/feedback-issue/feedback/issue.md"),
        "utf8"
      );
      expect(issueMarkdown).toBe(rendered.issueMarkdown);

      const issueUrl = await renderIssueUrl(cwd, "latest", "example/app");
      expect(issueUrl.ok).toBe(true);
      expect(issueUrl.issueUrl).toMatch(/^https:\/\/github\.com\/example\/app\/issues\/new\?/);
      expect(decodeURIComponent(issueUrl.issueUrl ?? "")).toContain("mimetic_feedback:");
    });
  });

  it("drafts feedback from run feedback candidates before dry-run fallback", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "feedback-candidate"
      });

      const runPath = path.join(cwd, ".mimetic/runs/feedback-candidate/run.json");
      const setupPath = path.join(cwd, ".mimetic/runs/feedback-candidate/setup-quality/oss-01-setup-quality.json");
      await mkdir(path.dirname(setupPath), { recursive: true });
      await writeFile(setupPath, JSON.stringify({ schema: "mimetic.setup-quality.v1", status: "needs_review" }, null, 2), "utf8");

      const bundle = JSON.parse(await readFile(runPath, "utf8")) as {
        feedbackCandidates: unknown[];
      };
      bundle.feedbackCandidates = [
        {
          schema: "mimetic.feedback-candidate.v1",
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
          expected: "The actor should create a complete Mimetic setup.",
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
          idempotency_key: "mimetic:feedback-candidate:setup-quality",
          proposed_next_state: "setup-quality-review",
          acceptance_proof: [
            "pnpm mimetic -- verify --run feedback-candidate --json"
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
        path: ".mimetic/runs/feedback-candidate/setup-quality/oss-01-setup-quality.json",
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
      expect(issue.stdout).toContain("mimetic_feedback:");
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
