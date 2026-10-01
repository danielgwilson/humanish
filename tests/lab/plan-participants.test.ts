// planParticipants must produce the same participants the routes build today. Computer use is
// compared field by field with the lane specs planCuaParticipants builds. The shared-world seat builder
// is private, so seats are compared with what a shared-world dry run records (seat ids, persona
// ids, assignment, rendered resolution); limits, entry and host are checked directly.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { routeOf } from "../../src/lab/plan.js";
import {
  computerUseParticipants,
  sharedWorldSeats,
  type ComputerUseParticipant,
} from "../../src/lab/plan-participants.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { planCuaParticipants } from "../../src/routes/computer-use/lane-plan.js";
import type { DesktopParticipantRun } from "../../src/routes/computer-use/types.js";
import { runConcurrentSharedWorld } from "../../src/routes/shared-world/lab.js";
import { prepareSelectedOutputDirectory } from "../../src/run/contained-output.js";
import { committedLabs } from "../helpers/committed-labs.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-plan-participants-"));
  cleanup.push(dir);
  return dir;
}

function parsed(raw: Record<string, unknown>): LabConfig {
  const result = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "plan-participants", ...raw });
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

async function committedLabsOn(route: string): Promise<[string, LabConfig][]> {
  return (await committedLabs(ROOT)).filter(([, config]) => routeOf(config) === route);
}

const stop = { any: [{ textIncludes: "Done" }] };
const cuApp = {
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  execution: { target: "e2b-desktop", timeoutMs: 60_000 },
};

const cuVariants: [string, LabConfig, number | undefined][] = [
  [
    "homogeneous count with actor-level fields",
    parsed({
      ...cuApp,
      actors: [
        {
          type: "openai-computer-use",
          count: 3,
          persona: "first-time-visitor",
          mission: "Sign up.",
          laneFocus: { instruction: "Use the keyboard." },
          stopWhen: stop,
          reasoningEffort: "high",
          maxOutputTokens: 2000,
          tasks: [{ id: "sign-up", goal: "Create an account." }],
        },
      ],
    }),
    undefined,
  ],
  [
    "roster with overrides and fallbacks",
    parsed({
      ...cuApp,
      actors: [
        {
          type: "openai-computer-use",
          persona: "fallback-persona",
          stopWhen: stop,
          reasoningEffort: "low",
          lanes: [
            { id: "host", persona: "own-persona", device: "small-mobile", instruction: "Host." },
            { actorType: "viewer", surface: "feed", caseGroup: "case-1", reasoningEffort: "high" },
            { dwell: { ms: 2000, everyMs: 1000, then: "continue" } },
          ],
        },
      ],
    }),
    undefined,
  ],
  [
    "per-lane targets",
    parsed({
      ...cuApp,
      actors: [
        {
          type: "openai-computer-use",
          lanes: [{ target: "http://127.0.0.1:3001/" }, { target: "http://127.0.0.1:3002/" }],
        },
      ],
    }),
    undefined,
  ],
  [
    "raw resolution",
    parsed({
      ...cuApp,
      execution: { ...cuApp.execution, desktop: { resolution: [1280, 800] } },
      actors: [{ type: "openai-computer-use" }],
    }),
    undefined,
  ],
  ["count override", parsed({ ...cuApp, actors: [{ type: "openai-computer-use", count: 2 }] }), 4],
];

/** The declarative fields of a lane spec, in the participant's shape. */
function fromSpec(spec: DesktopParticipantRun) {
  return {
    id: spec.planned.id,
    index: spec.planned.index,
    personaId: spec.persona.id,
    focus: spec.evidenceAssignment?.focus,
    labels: {
      actorType: spec.planned.labels.actorType,
      surface: spec.planned.labels.surface,
      caseGroup: spec.planned.labels.caseGroup,
    },
    device: {
      name: spec.planned.device.name,
      preset: spec.planned.device.preset,
      resolution: spec.planned.device.resolution,
    },
    limits: {
      stopWhen: spec.planned.limits.stopWhen,
      dwell: spec.planned.limits.dwell,
      reasoningEffort: spec.planned.limits.reasoningEffort,
      maxOutputTokens: spec.planned.limits.maxOutputTokens,
    },
    tasks: spec.planned.tasks,
    targetUrl: spec.planned.targetUrl,
  };
}

function fromParticipant(participant: ComputerUseParticipant) {
  return {
    id: participant.id,
    index: participant.index,
    // composeLaneInstructions names a lane without a persona "cua-operator".
    personaId: participant.personaId ?? "cua-operator",
    focus: participant.assignment.focus,
    labels: { ...participant.labels },
    device: { ...participant.device },
    limits: { ...participant.limits },
    tasks: participant.tasks,
    targetUrl: participant.targetUrl,
  };
}

/** Undefined keys and absent keys compare equal. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("computerUseParticipants", () => {
  it("matches the lane specs planCuaParticipants builds, for committed labs and variants", async () => {
    const configs: [string, LabConfig, number | undefined][] = [
      ...(await committedLabsOn("computer-use")).map(
        ([id, config]) => [id, config, undefined] as [string, LabConfig, undefined],
      ),
      ...cuVariants,
    ];
    expect(configs.length).toBeGreaterThan(cuVariants.length);
    for (const [name, config, countOverride] of configs) {
      const cwd = await tempProject();
      const lanes = await planCuaParticipants({
        config,
        cwd,
        projectRoot: await prepareSelectedOutputDirectory(path.dirname(cwd), cwd),
        env: {},
        dryRun: true,
        ...(countOverride === undefined ? {} : { countOverride }),
      });
      if (!lanes.ok) throw new Error(`${name}: ${lanes.message}`);
      const participants = computerUseParticipants(config, countOverride);
      expect(plain(participants.map(fromParticipant)), name).toEqual(
        plain(lanes.participantRuns.map(fromSpec)),
      );
      for (const [index, participant] of participants.entries()) {
        const declared = config.actors[0]?.mission;
        expect(participant.assignment.mission, name).toBe(declared);
        if (declared !== undefined)
          expect(lanes.participantRuns[index]?.evidenceAssignment?.mission, name).toBe(declared);
      }
    }
  });
});

describe("sharedWorldSeats", () => {
  const unnamedSeats = parsed({
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes", command: "echo 1" }],
      },
    },
    actors: [
      {
        type: "openai-computer-use",
        persona: "fallback-persona",
        mission: "Share the app.",
        stopWhen: stop,
        lanes: [
          { id: "author", persona: "author", entry: "/compose", device: "small-mobile" },
          { instruction: "Review.", reasoningEffort: "high" },
        ],
      },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  });

  it("matches the seats a shared-world dry run records", async () => {
    const configs = [
      ...(await committedLabsOn("shared-world")),
      ["unnamed seats", unnamedSeats] as [string, LabConfig],
    ];
    for (const [name, config] of configs) {
      const cwd = await tempProject();
      const result = await runConcurrentSharedWorld({ cwd, config, dryRun: true });
      if (!result.ok) throw new Error(`${name}: ${result.error?.message}`);
      const run = JSON.parse(
        await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
      ) as {
        streams: {
          assignment?: { mission?: string; focus?: string };
          desktopGeometry?: { screen?: { requested?: { width: number; height: number } } };
        }[];
      };
      const { seats } = sharedWorldSeats(config);
      expect(
        seats.map((seat) => ({ id: seat.id, persona: seat.personaId ?? "cua-operator" })),
        name,
      ).toEqual(result.roles.map((role) => ({ id: role.id, persona: role.persona })));
      for (const [index, seat] of seats.entries()) {
        const stream = run.streams[index];
        expect(stream?.assignment?.focus, name).toBe(seat.assignment.focus);
        if (seat.assignment.mission !== undefined)
          expect(stream?.assignment?.mission, name).toBe(seat.assignment.mission);
        expect(stream?.desktopGeometry?.screen?.requested, name).toEqual({
          width: seat.device.resolution[0],
          height: seat.device.resolution[1],
        });
      }
    }
  });

  it("merges limits and keeps plane-specific fields", () => {
    const provisioned = sharedWorldSeats(unnamedSeats);
    expect(provisioned.plane).toBe("provisioned");
    expect(provisioned.seats.map((seat) => seat.id)).toEqual(["author", "role-02"]);
    expect(provisioned.seats.map((seat) => seat.personaId)).toEqual(["author", "fallback-persona"]);
    expect(provisioned.plane === "provisioned" && provisioned.seats[0]?.entry).toBe("/compose");
    expect(provisioned.seats[1]?.limits).toEqual({ stopWhen: stop, reasoningEffort: "high" });
    expect(provisioned.seats[0]?.device.name).toBe("small-mobile");

    const external = sharedWorldSeats(
      parsed({
        subject: {
          source: "app-url",
          appUrl: "https://app.example.com/",
          topology: "shared-world",
          publicTarget: { owner: "example-org", authorized: true },
        },
        actors: [{ type: "openai-computer-use", lanes: [{ id: "h", host: true }, { id: "g" }] }],
        execution: { target: "e2b-desktop", timeoutMs: 60_000 },
        policies: { allowPublicTargets: true },
      }),
    );
    expect(external.plane).toBe("external-public");
    expect(external.plane === "external-public" && external.seats.map((seat) => seat.host)).toEqual(
      [true, false],
    );
  });
});
