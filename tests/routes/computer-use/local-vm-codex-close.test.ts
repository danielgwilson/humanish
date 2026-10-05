import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STUDY_SCHEMA } from "../../../src/study/types.js";
import { libraryConfig } from "../../helpers/library-config.js";

const participant = vi.hoisted(() => ({
  provider: { id: "restricted-codex-participant" },
  close: vi.fn(),
}));
vi.mock("../../../src/actors/codex/restricted-participant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/actors/codex/restricted-participant.js")>()),
  createRestrictedCodexParticipant: vi.fn(() => participant),
}));

import { prepareLocalVmRun } from "../../../src/routes/computer-use/local-vm.js";
import { closeParticipantModel } from "../../../src/routes/computer-use/participant-model.js";

const config = libraryConfig({
  schema: STUDY_SCHEMA,
  id: "local-codex-close",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:4173/" },
  actor: { type: "local-agent", mission: "Save a synthetic note." },
  execution: { target: "local" },
});

describe("local study Codex participant close", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-codex-close-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("hands the participant the native session's warnings and late refusal", async () => {
    participant.close.mockResolvedValue({
      status: "confirmed",
      warnings: ["synthetic unknown-method warning"],
      refusal: "codex_tool_call",
    });
    const study = prepareLocalVmRun({
      cwd,
      config,
      dryRun: false,
      assets: { image: "synthetic-image", runtimeRevision: "synthetic-revision" },
    });
    const provider = await study.options.createProvider!({ executor: {} } as never);
    const warnings: string[] = [];

    expect(await closeParticipantModel({ provider }, warnings)).toEqual({
      unconfirmed: false,
      refusal: "codex_tool_call",
    });
    expect(warnings).toEqual(["synthetic unknown-method warning"]);
    await study.close();
  });

  it("ignores a closeReport method on a provider it did not register", async () => {
    const provider = {
      id: "synthetic-provider",
      close: async () => undefined,
      closeReport: () => {
        throw new Error("not a Codex report");
      },
    };
    const warnings: string[] = [];
    expect(await closeParticipantModel({ provider } as never, warnings)).toEqual({
      unconfirmed: false,
      refusal: undefined,
    });
    expect(warnings).toEqual([]);
  });
});
