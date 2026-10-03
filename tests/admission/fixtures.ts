// Valid raw manifests, one per route shape. Admission cases mutate a deep copy of one of these, so
// every case differs from a runnable lab by the one rule it exercises.

import { V2_SCHEMA } from "../../src/study/types.js";

export type RawLab = Record<string, unknown>;

const serve = { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" };
const cuActor = { type: "openai-computer-use", persona: "first-time-visitor", mission: "Try it." };

const bases = {
  preview: {
    subject: { source: "this-repo" },
    actors: [{ type: "synthetic-persona" }],
  },
  cuAppUrl: {
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [cuActor],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuClone: {
    subject: { source: "clone", repos: ["example-org/example-app"], serve },
    actors: [cuActor],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuLocalTree: {
    subject: { source: "local-tree", serve },
    actors: [cuActor],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuDesktopCli: {
    subject: {
      source: "desktop-cli",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actors: [cuActor],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuLocalApp: {
    subject: { source: "local-app", appUrl: "http://127.0.0.1:3000/" },
    actors: [cuActor],
    execution: { target: "local", timeoutMs: 60_000 },
  },
  scriptedAppUrl: {
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [{ type: "scripted-browser", persona: "synthetic-new-user" }],
    scenario: { ref: "adm-journey" },
    execution: { target: "local", timeoutMs: 30_000 },
  },
  scriptedClone: {
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/example-app"],
      serve: { ...serve, start: "pnpm start --host 0.0.0.0" },
      state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
    },
    actors: [{ type: "scripted-browser", persona: "synthetic-provider", count: 1 }],
    scenario: { ref: "adm-journey" },
    execution: { target: "e2b-desktop", timeoutMs: 30_000 },
  },
  terminal: {
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Explore." }],
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      timeoutMs: 600_000,
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    scenario: { caps: { maxUsd: 0, maxMinutes: 5 } },
  },
  sharedProvisioned: {
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { ...serve, start: "pnpm start -H 0.0.0.0" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "psql query notes" }],
      },
    },
    actors: [
      {
        ...cuActor,
        lanes: [
          { id: "author", persona: "persona-1", entry: "/seat-1" },
          { id: "reviewer", persona: "persona-2", entry: "/seat-2" },
        ],
      },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  sharedExternal: {
    subject: {
      source: "app-url",
      appUrl: "https://app.example.com/",
      topology: "shared-world",
      publicTarget: { owner: "example-org", authorized: true },
    },
    actors: [{ ...cuActor, lanes: [{ id: "host", host: true }, { id: "guest" }] }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    policies: { allowPublicTargets: true },
  },
} satisfies Record<string, RawLab>;

export type BaseName = keyof typeof bases;

/** A patch value of `undefined` deletes the key; arrays and scalars replace. */
export type Patch = { readonly [key: string]: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

/**
 * A deep copy of a base manifest with `patch` merged in, and `actorPatch` merged into
 * `actors[0]`. Cases use it to write shapes the types forbid.
 */
export function lab(base: BaseName, patch: Patch = {}, actorPatch?: Patch): RawLab {
  const raw = merge(
    { schema: V2_SCHEMA, id: `adm-${base.toLowerCase()}`, ...structuredClone(bases[base]) },
    patch,
  ) as RawLab;
  if (actorPatch !== undefined) {
    const actors = raw.actors as unknown[];
    raw.actors = [merge(actors[0], actorPatch), ...actors.slice(1)];
  }
  return raw;
}

export const SCENARIO_YAML = `schema: humanish.scenario.v1
id: adm-journey
title: Admission journey
goal: Load the app.
browser:
  startPath: /
  steps:
    - id: step-01-load
      label: Load landing page
      action: goto
      path: /
      expect:
        selectorVisible: "main"
`;
