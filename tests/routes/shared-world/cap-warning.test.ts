// caps.maxUsd stops each shared-world participant on its own, so two participants can spend twice
// it before either stops. The run warns with that ceiling, as a computer-use fan-out does, unless
// the study declares one caps.maxTotalUsd budget. The warning names participant model spend: the
// external-public plane's lobby-code reads are not counted against either cap.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { runSharedWorld } from "../../helpers/route-run.js";

type Caps = { maxUsd?: number; maxTotalUsd?: number } | undefined;

function parsed(study: Record<string, unknown>, caps: Caps): StudyConfig {
  const result = parseStudy(caps === undefined ? study : { ...study, caps });
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const provisioned = (caps: Caps) =>
  parsed(
    {
      schema: STUDY_SCHEMA,
      id: "cap-warning-provisioned",
      route: "shared-world",
      mode: "live",
      subject: {
        source: "clone",
        exposure: "synthetic",
        repos: ["example-org/collab-app"],
        serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
        state: {
          seed: [{ name: "migrate", command: "pnpm db:migrate" }],
          checkpoint: [{ name: "notes-count", command: "psql query notes" }],
        },
      },
      actor: { type: "openai-computer-use", mission: "Use the shared app." },
      participants: [
        { id: "persona-01", persona: "persona-1" },
        { id: "persona-02", persona: "persona-2" },
        { id: "persona-03", persona: "persona-3" },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    },
    caps,
  );

const externalPublic = (caps: Caps) =>
  parsed(
    {
      schema: STUDY_SCHEMA,
      id: "cap-warning-external-public",
      route: "shared-world",
      mode: "live",
      subject: {
        source: "app-url",
        appUrl: "https://lobby-trivia.example.test/",
        publicTarget: { owner: "example-operator/lobby-trivia", authorized: true },
      },
      policies: { allowPublicTargets: true },
      actor: { type: "openai-computer-use", mission: "Play the multiplayer app with friends." },
      participants: [
        { id: "host", host: true, persona: "party-host", instruction: "Create a lobby." },
        { id: "player-2", persona: "casual-friend", instruction: "Join the lobby." },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    },
    caps,
  );

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-sw-cap-warning-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const capWarnings = (warnings: readonly string[]) =>
  warnings.filter((warning) => warning.startsWith("caps.maxUsd"));

describe("a shared-world study with a per-participant cap", () => {
  it("warns that three participants may spend three times caps.maxUsd", async () => {
    const result = await runSharedWorld({ cwd, config: provisioned({ maxUsd: 2 }), dryRun: true });
    expect(result.ok).toBe(true);
    expect(capWarnings(result.warnings)).toEqual([
      "caps.maxUsd ($2) caps each participant's model spend, so 3 participants may spend up to 3 × $2 (about $6) before any of them stops. Set caps.maxTotalUsd for one budget across the study.",
    ]);
  });

  it("warns on the external-public plane too", async () => {
    const result = await runSharedWorld({
      cwd,
      config: externalPublic({ maxUsd: 1.5 }),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(capWarnings(result.warnings)).toEqual([
      "caps.maxUsd ($1.5) caps each participant's model spend, so 2 participants may spend up to 2 × $1.5 (about $3) before any of them stops. Set caps.maxTotalUsd for one budget across the study.",
    ]);
  });

  it.each([
    { name: "a study budget", caps: { maxUsd: 2, maxTotalUsd: 3 } },
    { name: "only a study budget", caps: { maxTotalUsd: 3 } },
    { name: "no caps", caps: undefined },
  ])("does not warn with $name", async ({ caps }) => {
    const result = await runSharedWorld({ cwd, config: provisioned(caps), dryRun: true });
    expect(result.ok).toBe(true);
    expect(capWarnings(result.warnings)).toEqual([]);
  });
});
