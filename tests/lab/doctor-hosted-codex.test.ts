import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { DetectedLocalAgent } from "../../src/actors/local-agent/cli.js";
import { defaultCodexCliVersion } from "../../src/actors/codex/qualified-versions.js";
import { labSetupChecks, type LabSetupCheckArgs } from "../../src/lab/doctor.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const codex = (authStatus: DetectedLocalAgent["authStatus"]): DetectedLocalAgent => ({
  id: "codex",
  bin: "codex",
  label: "Codex",
  credentialPath: "/synthetic/auth.json",
  binPath: "/synthetic/codex",
  credentialsPresent: true,
  authStatus,
});

/** A hosted local-agent Codex lab, with the declared model and effort a run would use. */
const hostedLab = (actor: Record<string, unknown> = {}) =>
  stringify({
    schema: "humanish.lab.v2",
    id: "hosted-codex",
    subject: { source: "app-url", appUrl: "https://preview.example.test/" },
    actors: [{ type: "local-agent", localAgent: "codex", ...actor }],
    execution: { target: "e2b-desktop" },
    scenario: { mode: "live" },
    review: { analysis: false },
    policies: { allowPublicTargets: true },
  });

async function participantRow(
  manifest: string,
  readiness: NonNullable<LabSetupCheckArgs["codexParticipantReadiness"]>,
  agents: DetectedLocalAgent[] = [codex("authenticated")],
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-hosted-"));
  directories.push(cwd);
  await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
  await writeFile(path.join(cwd, "humanish/labs/hosted.yaml"), manifest);
  const result = await labSetupChecks({
    cwd,
    lab: "humanish/labs/hosted.yaml",
    env: { HUMANISH_STRICT_KEYS: "1", PATH: "" },
    agents,
    keyPresent: () => false,
    codexParticipantReadiness: readiness,
  });
  return result.checks.find((check) => check.name === "local participant authentication")!;
}

describe("doctor's hosted Codex participant check", () => {
  it("runs the operator handshake with the lab's model and effort, and reports what it admitted", async () => {
    const readiness = vi.fn<NonNullable<LabSetupCheckArgs["codexParticipantReadiness"]>>(
      async () => ({
        ready: true,
        errorCode: null,
        cliVersion: "0.160.0",
        resolvedModel: "gpt-5.6-sol",
        authentication: "chatgpt-account",
      }),
    );

    const row = await participantRow(
      hostedLab({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
      readiness,
    );

    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ PATH: "" }), {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(row.ok).toBe(true);
    expect(row.message).toContain("Codex CLI 0.160.0 passed the operator handshake without a turn");
    expect(row.message).toContain("model gpt-5.6-sol on a ChatGPT account");
  });

  it("says when the operator's Codex is signed in with an API key, which that key pays for", async () => {
    const row = await participantRow(hostedLab(), async () => ({
      ready: true,
      errorCode: null,
      cliVersion: "0.160.0",
      resolvedModel: "operator-model",
      authentication: "api-key",
    }));
    expect(row.message).toContain("an API key, which bills its usage to that key");
  });

  it("adds the schema values a passing handshake recorded to the ready row", async () => {
    const row = await participantRow(hostedLab(), async () => ({
      ready: true,
      errorCode: null,
      cliVersion: "0.161.0",
      resolvedModel: "operator-model",
      authentication: "chatgpt-account",
      protocolAdditions: ["item/completed item.type now also allows futureItem"],
    }));
    expect(row.ok).toBe(true);
    expect(row.message).toContain(
      "Codex CLI 0.161.0's app-server schema has values humanish has not seen: item/completed item.type now also allows futureItem. humanish recorded them and continued.",
    );
  });

  it("gives an unadmitted release the command that replaces the binary it found", async () => {
    const row = await participantRow(hostedLab(), async () => ({
      ready: false,
      errorCode: "codex_unsupported_version",
      detectedCliVersion: "0.150.0",
      installation: { kind: "global", path: "/usr/local/bin/codex" },
    }));
    expect(row.ok).toBe(false);
    expect(row.message).toContain("Hosted Codex participant setup is unavailable");
    expect(row.message).toContain("Found Codex CLI 0.150.0 at `/usr/local/bin/codex`");
    expect(row.message).toContain(`npm install -g @openai/codex@${defaultCodexCliVersion()}`);
  });

  it("points a refused operator configuration at that configuration", async () => {
    const row = await participantRow(hostedLab(), async () => ({
      ready: false,
      errorCode: "codex_unsafe_configuration",
    }));
    expect(row.message).toContain("(codex_unsafe_configuration)");
    expect(row.message).toContain("the operator's Codex configuration");
  });

  it("keeps the sign-in row for a signed-out Codex and skips the handshake", async () => {
    const readiness = vi.fn<NonNullable<LabSetupCheckArgs["codexParticipantReadiness"]>>();
    const row = await participantRow(hostedLab(), readiness, [codex("unauthenticated")]);
    expect(readiness).not.toHaveBeenCalled();
    expect(row).toMatchObject({ ok: false });
    expect(row.message).toContain("reports not signed in");
  });
});
