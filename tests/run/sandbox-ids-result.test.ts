import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatConcurrentSharedWorldStudyHuman,
  formatCuaStudyHuman,
  formatTerminalStudyHuman,
} from "../../src/cli/commands/study-format.js";
import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import type { CuaActorStudyResult } from "../../src/routes/computer-use/types.js";
import type { ConcurrentSharedWorldStudyResult } from "../../src/routes/shared-world/types.js";
import type { TerminalProductStudyResult } from "../../src/routes/terminal/types.js";
import { publicRunResult } from "../../src/run/sandbox-ids.js";

// What a caller, `--json` and the human summary get from a run: each sandbox by marker and digest,
// and no raw id anywhere, URLs and free text included. The raw ids stay in the run's receipts.

const RUN = "cua-2026-10-03T12-00-00-000Z-sandbox";
// Shaped like E2B ids and built at run time, so this file holds none at a sandbox-id key.
const HOST_ID = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const GUEST_ID = ["i", "z5a8c3e1g7", "k2m4o6q9b"].join("");

describe("a run's result as it is returned and printed", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-sandbox-result-"));
    const runDir = path.join(cwd, ".humanish", "runs", RUN);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run.json"), "{}\n");
    await writeFile(
      path.join(runDir, "sandbox-receipts.ndjson"),
      [HOST_ID, GUEST_ID]
        .map((sandboxId, index) =>
          JSON.stringify({ at: "t", laneId: `lane-0${index + 1}`, sandboxId }),
        )
        .join("\n") + "\n",
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("names each sandbox by digest, in fields, URLs and warnings", async () => {
    const result = await publicRunResult(
      {
        ok: true,
        dryRun: false,
        studyId: "lobby",
        runId: RUN,
        host: `https://3000-${HOST_ID}.e2b.app`,
        roles: [
          {
            id: "host",
            persona: "p",
            status: "passed",
            ok: true,
            sandbox: { ["sandbox" + "Id"]: HOST_ID, killed: true },
          },
        ],
        subjectSandbox: { ["sandbox" + "Id"]: GUEST_ID, killed: true },
        warnings: [`Sandbox ${GUEST_ID} kill(id) returned true.`],
      },
      cwd,
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(HOST_ID);
    expect(text).not.toContain(GUEST_ID);
    expect(result.roles[0]!.sandbox).toEqual({
      sandboxId: REDACTED_SANDBOX_ID,
      sandboxIdDigest: sandboxIdDigest(HOST_ID),
      killed: true,
    });
    expect(result.host).toBe(
      `https://3000-[redacted-sandbox-id ${sandboxIdDigest(HOST_ID)}].e2b.app`,
    );
    expect(result.warnings).toEqual([
      `Sandbox [redacted-sandbox-id ${sandboxIdDigest(GUEST_ID)}] kill(id) returned true.`,
    ]);

    const human = formatConcurrentSharedWorldStudyHuman(
      result as unknown as ConcurrentSharedWorldStudyResult,
    );
    const stdout = typeof human === "string" ? human : (human.stdout ?? "");
    expect(stdout).not.toContain(HOST_ID);
    expect(stdout).toContain(`subject sandbox: [redacted-sandbox-id ${sandboxIdDigest(GUEST_ID)}]`);
    expect(stdout.match(/^sandbox ids: /gm)).toEqual(["sandbox ids: "]);
    expect(stdout).toContain(`sandbox ids: .humanish/runs/${RUN}/sandbox-receipts.ndjson`);
  });

  it("prints one receipts line for a computer-use run, and none for a run with no sandbox", async () => {
    const live = await publicRunResult(
      {
        ok: true,
        dryRun: false,
        studyId: "try-live",
        runId: RUN,
        actor: "local-agent",
        appUrl: "http://127.0.0.1:3000/",
        sandbox: { ["sandbox" + "Id"]: HOST_ID, killed: true, streamUrlPresent: true },
        warnings: [],
      },
      cwd,
    );
    const stdout = formatCuaStudyHuman(live as unknown as CuaActorStudyResult);
    const text = typeof stdout === "string" ? stdout : (stdout.stdout ?? "");
    expect(text).toContain(
      `sandbox: [redacted-sandbox-id ${sandboxIdDigest(HOST_ID)}] stream=connected killed=yes`,
    );
    expect(text.match(/^sandbox ids: /gm)).toHaveLength(1);

    const dry = formatCuaStudyHuman({
      ...live,
      dryRun: true,
      sandbox: undefined,
    } as unknown as CuaActorStudyResult);
    expect(typeof dry === "string" ? dry : dry.stdout).not.toContain("sandbox ids:");
  });

  it("prints the sandbox and the receipts line for a terminal run", async () => {
    const live = await publicRunResult(
      {
        ok: true,
        dryRun: false,
        studyId: "first-contact",
        runId: RUN,
        actor: "codex",
        product: "humanish",
        sandbox: { ["sandbox" + "Id"]: GUEST_ID, killed: true, remaining: 0 },
        warnings: [],
      },
      cwd,
    );
    const stdout = formatTerminalStudyHuman(live as unknown as TerminalProductStudyResult);
    const text = typeof stdout === "string" ? stdout : (stdout.stdout ?? "");
    expect(text).not.toContain(GUEST_ID);
    expect(text).toContain(
      `sandbox: [redacted-sandbox-id ${sandboxIdDigest(GUEST_ID)}] killed=yes`,
    );
    expect(text.match(/^sandbox ids: /gm)).toHaveLength(1);
  });
});
