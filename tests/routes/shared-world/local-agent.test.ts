// A shared-world study with a local-agent brain runs each participant on the operator's signed-in
// agent: the participants' runner deps carry the plan's brain, the route checks its sign-in before
// acquiring anything, and only the external-public plane's lobby-code reader asks for
// OPENAI_API_KEY.

import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../../src/lab/config.js";
import { planLab } from "../../../src/lab/plan.js";
import { runLab } from "../../../src/run-lab.js";
import { participantRunDeps } from "../../../src/routes/shared-world/participant-specs.js";
import type { PlaneContext } from "../../../src/routes/shared-world/types.js";
import { lab, SCENARIO_YAML } from "../../admission/fixtures.js";
import { defaultCodexCliVersion } from "../../../src/actors/codex/codex-admission.js";
import { restrictedCodexNpmTarget } from "../../../src/actors/codex/restricted-executable.js";

const live = { scenario: { mode: "live" } };
const localAgent = { type: "local-agent", localAgent: "codex" };
const cleanup: string[] = [];

afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-sw-local-agent-"));
  cleanup.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "name": "sw-local-agent-fixture" }\n');
  await mkdir(path.join(dir, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(dir, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return dir;
}

function config(base: "sharedProvisioned" | "sharedExternal", actor?: Record<string, unknown>) {
  const parsed = parseLabConfig(lab(base, live, actor));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** The plane context fields participantRunDeps reads; the rest stay undefined. */
function planeContext(brain: PlaneContext["plan"]["brain"]): PlaneContext {
  return {
    plan: { brain, plane: { participants: [{}, {}] } },
    input: {},
    config: { subject: {} },
    descriptor: { id: "local-agent" },
    deps: {},
    env: {},
    openaiApiKey: "",
    e2bApiKey: "synthetic-e2b",
    timeoutMs: 60_000,
    requestTimeoutMs: 30_000,
    now: () => 0,
  } as unknown as PlaneContext;
}

describe("shared world with a local-agent brain", () => {
  it("hands each participant's runner the plan's brain, with its agent and declared model", () => {
    const live = { streamUrls: [] };
    const scrub = (text: string) => text;
    const localAgent = {
      kind: "local-agent",
      agent: "codex",
      declaredModel: "gpt-6-astra",
    } as const;
    const openai = { kind: "openai", model: "gpt-6-astra" } as const;
    expect(participantRunDeps(planeContext(localAgent), live, scrub).brain).toBe(localAgent);
    expect(participantRunDeps(planeContext(openai), live, scrub).brain).toBe(openai);
  });

  it("declares OPENAI_API_KEY only for the external-public plane's lobby-code reader", async () => {
    const cwd = await projectDir();
    const keysOf = (base: "sharedProvisioned" | "sharedExternal") => {
      const planned = planLab(config(base, localAgent), { cwd });
      if (!planned.ok) throw new Error(planned.refusal.message);
      return planned.planned.plan.requirements.flatMap((requirement) =>
        requirement.kind === "key" ? [requirement.name] : [],
      );
    };
    expect(keysOf("sharedProvisioned")).toEqual(["E2B_API_KEY"]);
    expect(keysOf("sharedExternal")).toEqual(["E2B_API_KEY", "OPENAI_API_KEY"]);
  });

  it("refuses a missing agent CLI as AGENT_MISSING before any desktop loads, without OPENAI_API_KEY", async () => {
    const cwd = await projectDir();
    let loads = 0;
    const outcome = await runLab(
      config("sharedProvisioned", localAgent),
      {
        cwd,
        // No `PATH`: the codex CLI cannot be found.
        env: { E2B_API_KEY: "synthetic-e2b", DATABASE_URL: "postgres://synthetic" },
      },
      {
        desktopModule: async () => {
          loads += 1;
          throw new Error("a missing-agent refusal must come before any desktop loads");
        },
      },
    );
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_SHARED_WORLD_AGENT_MISSING");
    expect(outcome.result.error?.message).toContain("needs the codex CLI on PATH and signed in");
    expect(loads).toBe(0);
    expect(await readdir(path.join(cwd, ".humanish", "runs")).catch(() => [])).toEqual([]);
  });

  /** A `PATH` holding a signed-in ChatGPT-account `codex` that reports `version`. */
  async function signedInCodex(version: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "humanish-sw-codex-"));
    cleanup.push(dir);
    const bin = path.join(dir, "codex");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi`,
        'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
        "exit 3",
      ].join("\n") + "\n",
    );
    await chmod(bin, 0o755);
    return dir;
  }

  async function refusedWith(codexPath: string, caps?: Record<string, number>) {
    const cwd = await projectDir();
    let loads = 0;
    const base = lab("sharedProvisioned", live, localAgent);
    const raw =
      caps === undefined ? base : { ...base, execution: { ...(base.execution as object), caps } };
    const parsed = parseLabConfig(raw);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(
      parsed.config,
      {
        cwd,
        env: { PATH: codexPath, HOME: codexPath, E2B_API_KEY: "e2b", DATABASE_URL: "postgres://x" },
      },
      {
        desktopModule: async () => {
          loads += 1;
          throw new Error("a local-agent refusal must come before any desktop loads");
        },
      },
    );
    expect(loads).toBe(0);
    return outcome.result.error;
  }

  it("refuses a signed-out agent CLI as AGENT_SIGNIN_REQUIRED", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "humanish-sw-codex-"));
    cleanup.push(dir);
    await writeFile(path.join(dir, "codex"), '#!/bin/sh\necho "Not logged in"\nexit 1\n');
    await chmod(path.join(dir, "codex"), 0o755);
    const error = await refusedWith(dir);
    expect(error?.code).toBe("HUMANISH_SHARED_WORLD_AGENT_SIGNIN_REQUIRED");
    expect(error?.message).toContain("reports it is not signed in");
  });

  it("refuses a Codex release below the floor as ACTOR_UNSUPPORTED", async () => {
    expect((await refusedWith(await signedInCodex("0.0.1")))?.code).toBe(
      "HUMANISH_SHARED_WORLD_ACTOR_UNSUPPORTED",
    );
  });

  const qualified = defaultCodexCliVersion();
  it.skipIf(restrictedCodexNpmTarget(process.platform, process.arch) === undefined || !qualified)(
    "refuses a dollar cap on a ChatGPT-account Codex as UNPRICED_CAP",
    async () => {
      const error = await refusedWith(await signedInCodex(qualified!), { maxUsd: 1 });
      expect(error?.code).toBe("HUMANISH_SHARED_WORLD_UNPRICED_CAP");
      expect(error?.message).toContain("no API-dollar price");
    },
  );
});
