import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FEEDBACK_SCHEMA } from "../src/feedback.js";
import { RUN_BUNDLE_SCHEMA } from "../src/run.js";

interface AdapterFixture {
  schema: string;
  id: string;
  authority: {
    github_mutation: string;
    mode: string;
    network_policy: string;
    spend_policy: string;
    hosted_product_memory_required?: boolean;
  };
  routes?: Array<{ id: string; path: string }>;
  commands?: Array<{ id: string; command: string }>;
}

interface RunBundleFixture {
  schema: string;
  runId: string;
  mode: string;
  source: {
    packageName: string | null;
  };
  persona: {
    id: string;
  };
  scenario: {
    id: string;
  };
  lifecycle: Array<{ event: string; message: string }>;
  simulations: Array<{
    mode: string;
    scenarioId: string;
    streamKind: string;
  }>;
  streams: Array<{
    artifacts: Array<{ kind: string; label: string; path: string }>;
    kind: string;
    terminal?: { tail: string };
    ui?: { route?: string; state?: string };
  }>;
  redaction: {
    status: string;
  };
  artifacts: Record<string, string>;
  review: {
    verdict: string;
  };
  feedbackCandidates: Array<Record<string, unknown>>;
}

interface FeedbackDraftFixture {
  schema: string;
  adapter_id: string;
  evidence: Array<{ kind: string; path: string }>;
  github?: {
    mutation: string;
    requires_token: boolean;
  };
  redaction: {
    status: string;
  };
}

interface VerifyResultFixture {
  schema: string;
  ok: boolean;
  checks: Array<{
    message: string;
    name: string;
    ok: boolean;
  }>;
}

const fixtureRoot = "adapters/fixtures";
const genericSensitivePatterns = [
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^https?:\/\//
];

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(relativePath, "utf8")) as T;
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, strings);
    }
    return strings;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, strings);
    }
  }

  return strings;
}

function expectPublicSafeFixture(value: unknown): void {
  for (const text of collectStrings(value)) {
    for (const pattern of genericSensitivePatterns) {
      expect(text).not.toMatch(pattern);
    }
  }
}

function expectRelativeArtifactPaths(bundle: RunBundleFixture): void {
  const artifactPaths = [
    ...Object.values(bundle.artifacts),
    ...bundle.streams.flatMap((stream) => stream.artifacts.map((artifact) => artifact.path))
  ];

  for (const artifactPath of artifactPaths) {
    expect(path.isAbsolute(artifactPath)).toBe(false);
    expect(artifactPath).not.toContain("..");
    expect(artifactPath).not.toMatch(/^https?:\/\//);
  }
}

describe("adapter fixture parity contracts", () => {
  it("commits the expected public-safe fixture packets", async () => {
    const fixtureDirs = (await readdir(fixtureRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const contract = await readFile("docs/contracts/adapter-fixtures.md", "utf8");

    expect(fixtureDirs).toEqual(["post-auth-return-dry-run", "terminal-feedback-lifecycle"]);
    for (const fixtureDir of fixtureDirs) {
      expect(contract).toContain(fixtureDir);
    }
  });

  it("defines a web-app dry-run fixture with adapter-owned routes and milestones", async () => {
    const root = `${fixtureRoot}/post-auth-return-dry-run`;
    const adapter = await readJson<AdapterFixture>(`${root}/adapter.json`);
    const milestones = await readJson<{ milestones: Array<{ id: string; route: string }> }>(`${root}/milestones.json`);
    const bundle = await readJson<RunBundleFixture>(`${root}/run-bundle.json`);

    expectPublicSafeFixture({ adapter, milestones, bundle });
    expect(adapter.schema).toBe("mimetic.adapter.v1");
    expect(adapter.authority).toEqual(expect.objectContaining({
      github_mutation: "not_requested",
      mode: "contract_fixture",
      network_policy: "no_network",
      spend_policy: "no_spend"
    }));
    expect(adapter.routes?.map((route) => route.id).sort()).toEqual(["auth-return", "studio", "upload"]);
    expect(milestones.milestones.map((milestone) => milestone.id).sort()).toEqual([
      "auth-return-complete",
      "studio-ready",
      "upload-ready"
    ]);

    expect(bundle.schema).toBe(RUN_BUNDLE_SCHEMA);
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.source.packageName).toBe("fixture-upload-studio");
    expect(bundle.persona.id).toBe("synthetic-returning-creator");
    expect(bundle.scenario.id).toBe("post-auth-return-dry-run");
    expect(bundle.redaction.status).toBe("passed");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.streams.map((stream) => stream.ui?.route).filter(Boolean).sort()).toEqual([
      "/auth/return",
      "/studio",
      "/upload"
    ]);
    expect(bundle.lifecycle.filter((event) => event.event === "milestone.reached").map((event) => event.message).sort()).toEqual([
      "auth-return-complete",
      "studio-ready",
      "upload-ready"
    ]);
    expect(bundle.streams.every((stream) => stream.artifacts.some((artifact) => artifact.path === "milestones.json"))).toBe(true);
    expectRelativeArtifactPaths(bundle);
  });

  it("defines a terminal fixture with feedback draft and policy proof", async () => {
    const root = `${fixtureRoot}/terminal-feedback-lifecycle`;
    const adapter = await readJson<AdapterFixture>(`${root}/adapter.json`);
    const policy = await readJson<{
      github: { mutation: string; requires_token: boolean };
      hosted_product_memory: { required: boolean };
      network_policy: string;
      redaction: { status: string };
      spend_policy: string;
    }>(`${root}/policy.json`);
    const bundle = await readJson<RunBundleFixture>(`${root}/run-bundle.json`);
    const feedbackDraft = await readJson<FeedbackDraftFixture>(`${root}/feedback-draft.json`);
    const verifyResult = await readJson<VerifyResultFixture>(`${root}/verify-result.json`);
    const sanitizedTranscript = await readFile(`${root}/transcripts/sanitized-terminal.txt`, "utf8");

    expectPublicSafeFixture({ adapter, policy, bundle, feedbackDraft, verifyResult, sanitizedTranscript });
    expect(adapter.schema).toBe("mimetic.adapter.v1");
    expect(adapter.commands?.map((command) => command.id).sort()).toEqual(["feedback-draft", "start"]);
    expect(adapter.authority.hosted_product_memory_required).toBe(false);
    expect(policy.network_policy).toBe("no_network");
    expect(policy.spend_policy).toBe("no_spend");
    expect(policy.github).toEqual({ mutation: "not_requested", requires_token: false });
    expect(policy.hosted_product_memory.required).toBe(false);
    expect(policy.redaction.status).toBe("passed");

    expect(bundle.schema).toBe(RUN_BUNDLE_SCHEMA);
    expect(bundle.streams).toHaveLength(1);
    expect(bundle.streams[0]).toEqual(expect.objectContaining({ kind: "terminal" }));
    expect(bundle.streams[0]?.terminal?.tail).toContain("spend policy: no_spend");
    expect(bundle.streams[0]?.terminal?.tail).toContain("issue draft: ready");
    expect(bundle.streams[0]?.artifacts.map((artifact) => artifact.path).sort()).toEqual([
      "feedback-draft.json",
      "policy.json",
      "transcripts/sanitized-terminal.txt"
    ]);
    expect(bundle.feedbackCandidates).toEqual([
      expect.objectContaining({
        artifact: "feedback-draft.json",
        mutation: "not_requested",
        requiresGithubToken: false
      })
    ]);
    expectRelativeArtifactPaths(bundle);

    expect(feedbackDraft.schema).toBe(FEEDBACK_SCHEMA);
    expect(feedbackDraft.adapter_id).toBe("terminal-feedback-lifecycle");
    expect(feedbackDraft.redaction.status).toBe("passed");
    expect(feedbackDraft.github).toEqual({ mutation: "not_requested", requires_token: false });
    expect(feedbackDraft.evidence.map((item) => item.kind).sort()).toEqual(["state", "terminal", "trace"]);

    expect(sanitizedTranscript).toContain("synthetic sanitized transcript only");
    expect(verifyResult.schema).toBe("mimetic.verify-result.v1");
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.checks.every((check) => check.ok)).toBe(true);
    expect(verifyResult.checks.map((check) => check.name).sort()).toEqual([
      "feedback draft exists",
      "raw transcript not required",
      "redaction passed",
      "run bundle exists",
      "sanitized transcript pointer exists"
    ]);
  });

  it("keeps adapter-specific fixture nouns out of core contracts and runtime", async () => {
    const coreText = (
      await Promise.all([
        readFile("docs/contracts/schemas.md", "utf8"),
        readFile("docs/contracts/run-bundle.md", "utf8"),
        readFile("src/run.ts", "utf8")
      ])
    ).join("\n");

    for (const adapterOwnedTerm of [
      "post-auth-return-web-app",
      "upload-ready",
      "studio-ready",
      "auth-return-complete",
      "terminal-feedback-lifecycle"
    ]) {
      expect(coreText).not.toContain(adapterOwnedTerm);
    }
  });
});
