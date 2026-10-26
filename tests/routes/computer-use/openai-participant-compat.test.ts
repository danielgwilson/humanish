// What a committed openai-computer-use study's participants run with, pinned from the plan to the
// wire: the model each participant runs and is priced at, the plan's requirements, each
// participant's settings, and every OpenAI request body one scripted session sends. The golden was
// written before the participant vendor got a name in the plan, so a refactor of how the route
// builds the provider shows up here as a diff. Rerun with -u only for an intended behavior change.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import type { CuaExecutor } from "../../../src/actors/computer-use/loop.js";
import { participantSessionOptions } from "../../../src/routes/computer-use/participant-model.js";
import { participantRunsAndPlan } from "../../../src/routes/computer-use/participant-runs.js";
import { pricedModel } from "../../../src/study/plan-base.js";
import { planStudy } from "../../../src/study/plan.js";
import type { StudyPlan } from "../../../src/study/plan-types.js";
import { committedLabs } from "../../helpers/committed-labs.js";
import { TWO_TURN_SESSION } from "../../helpers/fanout-desktop.js";
import { participantRunDeps } from "../../helpers/participant-run.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const KEY = "synthetic-participant-key";
const NOW = Date.parse("2026-10-26T12:00:00Z");

const digest = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

/** A request body with each screenshot and the instructions replaced by a digest. */
function stable(value: unknown): unknown {
  if (typeof value === "string")
    return value.startsWith("data:image/") || value.length > 400 ? digest(value) : value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stable(entry)]));
  return value;
}

function executor(): CuaExecutor {
  const screenshot = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  return {
    observe: async () => ({
      screenshot,
      stateSignature: "page",
      text: "Notes",
      url: "http://127.0.0.1:3000/",
    }),
    execute: async () => undefined,
  };
}

interface Sent {
  url: string;
  /** The request carried the participant key the route read. */
  participantKey: boolean;
  body: unknown;
}

/** Fetch as the default OpenAI provider calls it: every request recorded, TWO_TURN_SESSION replies. */
function recordingFetch(sent: Sent[]) {
  return async (
    url: string,
    init: { headers: Record<string, string>; body: string },
  ): Promise<Response> => {
    sent.push({
      url,
      participantKey: init.headers.Authorization === `Bearer ${KEY}`,
      body: stable(JSON.parse(init.body)),
    });
    const reply = TWO_TURN_SESSION[Math.min(sent.length - 1, TWO_TURN_SESSION.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200 });
  };
}

/** One computer-use participant's session, run on the route's own options, and what it sent. */
async function sessionRequests(
  plan: Extract<StudyPlan, { route: "computer-use" }>,
  cwd: string,
): Promise<Record<string, unknown>> {
  const { runs } = participantRunsAndPlan(plan);
  const deps = await participantRunDeps(cwd, {
    brain: plan.runner.brain,
    caps: plan.caps,
    participantCount: runs.length,
    openaiApiKey: KEY,
  });
  const out: Record<string, unknown> = {};
  for (const spec of runs) {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", recordingFetch(sent));
    try {
      const options = participantSessionOptions(
        spec,
        deps,
        { executor: executor() },
        undefined,
        async (name) => name,
      );
      const result = await runCuaActorSession({ ...options, now: () => NOW });
      out[spec.planned.id] = {
        modelSettings: result.trace.modelSettings,
        model: result.trace.ids.model,
        requests: sent,
      };
    } finally {
      vi.unstubAllGlobals();
    }
  }
  return out;
}

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-openai-compat-"));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("committed openai-computer-use studies", () => {
  it("run the same model, requirements, settings and OpenAI requests", async () => {
    const pinned: Record<string, unknown> = {};
    for (const [id, config] of await committedLabs(ROOT)) {
      if (config.actor?.type !== "openai-computer-use") continue;
      const planned = planStudy(config, { cwd: ROOT, dryRun: false });
      if (!planned.ok) throw new Error(`${id} refused on ${planned.refusal.route}`);
      const plan = planned.planned.plan;
      if (plan.route !== "computer-use" && plan.route !== "shared-world")
        throw new Error(`${id} planned on ${plan.route}`);
      const brain = plan.route === "computer-use" ? plan.runner.brain : plan.brain;
      const participants =
        plan.route === "computer-use" ? plan.runner.participants : plan.plane.participants;
      pinned[id] = {
        model: "model" in brain ? brain.model : undefined,
        pricedModel: pricedModel(brain),
        requirements: plan.requirements,
        participants: Object.fromEntries(
          participants.map((participant) => [
            participant.id,
            "limits" in participant ? participant.limits : {},
          ]),
        ),
        ...(plan.route === "computer-use" ? { sessions: await sessionRequests(plan, cwd) } : {}),
      };
    }
    expect(Object.keys(pinned).length).toBeGreaterThan(10);
    await expect(`${JSON.stringify(pinned, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/plans/openai-participant-compat.json",
    );
  });
});
